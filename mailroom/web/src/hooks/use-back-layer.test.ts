import assert from "node:assert/strict";
import test from "node:test";
import type * as BackLayerModule from "./use-back-layer";
import type { BackWindowLike } from "./use-back-layer";

const {
  cloneBaseState,
  createBackHistoryController,
  isMailroomState,
} = (await import(new URL("./use-back-layer.ts", import.meta.url).href)) as typeof BackLayerModule;

interface SimEntry {
  url: string;
  state: unknown;
}

class SimulatedBrowserWindow implements BackWindowLike {
  entries: SimEntry[];
  index: number;
  private listeners: {
    popstate: Set<(ev: { state: unknown }) => void>;
    pageshow: Set<(ev: { persisted?: boolean }) => void>;
  } = {
    popstate: new Set(),
    pageshow: new Set(),
  };
  private queue: Array<() => void> = [];

  history: BackWindowLike["history"];

  constructor(initialEntries: SimEntry[], initialIndex = initialEntries.length - 1) {
    this.entries = initialEntries.map((e) => ({ url: e.url, state: cloneValue(e.state) }));
    this.index = initialIndex;

    const getState = () => this.entries[this.index]?.state ?? null;
    const push = (data: unknown, _unused: string, url?: string | URL | null) => {
      this.entries = this.entries.slice(0, this.index + 1);
      const nextUrl = url ? String(url) : this.entries[this.index]?.url ?? "/";
      this.entries.push({ url: nextUrl, state: cloneValue(data) });
      this.index = this.entries.length - 1;
    };
    const replace = (data: unknown, _unused: string, url?: string | URL | null) => {
      const nextUrl = url ? String(url) : this.entries[this.index]?.url ?? "/";
      this.entries[this.index] = { url: nextUrl, state: cloneValue(data) };
    };
    const go = (delta = 0) => {
      if (delta === 0) return;
      this.queue.push(() => {
        const target = this.index + delta;
        // Per HTML History spec, out-of-bounds go() is a no-op with no popstate.
        if (target < 0 || target >= this.entries.length) return;
        this.index = target;
        const cur = this.entries[this.index];
        const ev = { state: cloneValue(cur.state) };
        for (const fn of [...this.listeners.popstate]) fn(ev);
      });
    };

    this.history = {
      get state() {
        return getState();
      },
      pushState: push,
      replaceState: replace,
      back: () => go(-1),
      go,
    };
  }

  get currentUrl(): string {
    return this.entries[this.index]?.url ?? "";
  }

  get currentState(): unknown {
    return this.entries[this.index]?.state ?? null;
  }

  addEventListener(type: "popstate" | "pageshow", listener: ((ev: { state: unknown }) => void) | ((ev: { persisted?: boolean }) => void)): void {
    if (type === "popstate") {
      this.listeners.popstate.add(listener as (ev: { state: unknown }) => void);
    } else {
      this.listeners.pageshow.add(listener as (ev: { persisted?: boolean }) => void);
    }
  }

  removeEventListener(type: "popstate" | "pageshow", listener: ((ev: { state: unknown }) => void) | ((ev: { persisted?: boolean }) => void)): void {
    if (type === "popstate") {
      this.listeners.popstate.delete(listener as (ev: { state: unknown }) => void);
    } else {
      this.listeners.pageshow.delete(listener as (ev: { persisted?: boolean }) => void);
    }
  }

  userBack(): boolean {
    if (this.index <= 0) return false;
    this.history.go(-1);
    return true;
  }

  userJump(delta: number): boolean {
    const target = this.index + delta;
    if (target < 0 || target >= this.entries.length) return false;
    this.history.go(delta);
    return true;
  }

  userForward(): boolean {
    if (this.index >= this.entries.length - 1) return false;
    this.history.go(1);
    return true;
  }

  firePageShow(persisted = true): void {
    for (const fn of [...this.listeners.pageshow]) fn({ persisted });
  }

  async flush(maxSteps = 40): Promise<void> {
    for (let i = 0; i < maxSteps; i++) {
      await Promise.resolve();
      await Promise.resolve();
      const next = this.queue.shift();
      if (!next) {
        // Re-check once after microtasks in case microtask queued history.go
        await new Promise<void>((r) => setTimeout(r, 0));
        const nextAfterMacro = this.queue.shift();
        if (!nextAfterMacro) return;
        nextAfterMacro();
        continue;
      }
      next();
    }
    throw new Error("Exceeded max history flush steps");
  }
}

function cloneValue<T>(v: T): T {
  return v == null ? v : structuredClone(v);
}

test("cloneBaseState and isMailroomState preserve Next.js router fields and detect Mailroom entries", () => {
  const raw = {
    __NA: true,
    __PRIVATE_NEXTJS_INTERNALS_TREE: ["", { children: ["__PAGE__", {}] }],
    custom: "keep",
    mr: 4,
    mrRoot: false,
    mrSid: "old",
    mrDepth: 2,
  };
  assert.deepEqual(cloneBaseState(raw), {
    __NA: true,
    __PRIVATE_NEXTJS_INTERNALS_TREE: ["", { children: ["__PAGE__", {}] }],
    custom: "keep",
  });
  assert.equal(isMailroomState(raw), true);
  assert.equal(isMailroomState({ mrRoot: true }), true);
  assert.equal(isMailroomState({ mr: 1 }), true);
  assert.equal(isMailroomState({ mrSid: "s1" }), true);
  assert.equal(isMailroomState(null), false);
  assert.equal(isMailroomState({ __NA: true }), false);
});

test("basic LIFO pushes preserve Next.js __NA and leave to previous page immediately once exhausted", async () => {
  const win = new SimulatedBrowserWindow([
    { url: "https://example.com/prev", state: null },
    { url: "https://mailroom.local/", state: { __NA: true, tree: "t0" } },
  ]);
  const ctrl = createBackHistoryController(win, { sessionId: "s1" });
  const closed: string[] = [];

  ctrl.ensureRoot();
  const rootSt = win.currentState as Record<string, unknown>;
  assert.equal(rootSt.__NA, true);
  assert.equal(rootSt.tree, "t0");
  assert.equal(rootSt.mrRoot, true);
  assert.equal(rootSt.mrDepth, 0);
  assert.equal(ctrl.canGoBack(), false);

  ctrl.pushBack(() => closed.push("thread"));
  ctrl.pushBack(() => closed.push("compose"));
  assert.equal(win.index, 3);
  assert.equal(ctrl.canGoBack(), true);

  assert.equal(win.userBack(), true);
  await win.flush();
  assert.deepEqual(closed, ["compose"]);
  assert.equal(win.index, 2);

  assert.equal(win.userBack(), true);
  await win.flush();
  assert.deepEqual(closed, ["compose", "thread"]);
  assert.equal(win.index, 1);
  assert.equal(ctrl.canGoBack(), false);

  // Very next Back leaves Mailroom for /prev.
  assert.equal(win.userBack(), true);
  await win.flush();
  assert.equal(win.index, 0);
  assert.equal(win.currentUrl, "https://example.com/prev");
  ctrl.destroy();
});

test("fresh tab with no prior page exhausts directly to index 0", async () => {
  const win = new SimulatedBrowserWindow([
    { url: "https://mailroom.local/", state: { __NA: true } },
  ]);
  const ctrl = createBackHistoryController(win, { sessionId: "s1" });
  const closed: string[] = [];

  ctrl.ensureRoot();
  ctrl.pushBack(() => closed.push("team"));
  ctrl.pushBack(() => closed.push("goals"));
  assert.equal(win.index, 2);

  win.userBack();
  await win.flush();
  win.userBack();
  await win.flush();
  assert.deepEqual(closed, ["goals", "team"]);
  assert.equal(win.index, 0);
  assert.equal(win.userBack(), false);
  ctrl.destroy();
});

test("out-of-order UI closes coalesce cleanly so the very next Back leaves Mailroom", async () => {
  const win = new SimulatedBrowserWindow([
    { url: "/prev", state: null },
    { url: "/", state: { __NA: true } },
  ]);
  const ctrl = createBackHistoryController(win, { sessionId: "s1" });
  ctrl.ensureRoot();

  const closed: string[] = [];
  const dropA = ctrl.pushBack(() => closed.push("A"));
  const dropB = ctrl.pushBack(() => closed.push("B"));
  assert.equal(win.index, 3);

  // Close lower layer A via UI, then close top layer B via UI (historically broke suppressPops + noopIds).
  dropA();
  await win.flush();
  assert.equal(win.index, 3); // still on B until B closes

  dropB();
  await win.flush();
  assert.equal(win.index, 1); // jumped directly back to Root!
  assert.deepEqual(closed, []);
  assert.equal(ctrl.canGoBack(), false);

  win.userBack();
  await win.flush();
  assert.equal(win.currentUrl, "/prev");
  ctrl.destroy();
});

test("out-of-order UI close under top layer skips dead layer on Back without extra presses", async () => {
  const win = new SimulatedBrowserWindow([
    { url: "/prev", state: null },
    { url: "/", state: { __NA: true } },
  ]);
  const ctrl = createBackHistoryController(win, { sessionId: "s2" });
  ctrl.ensureRoot();

  const closed: string[] = [];
  ctrl.pushBack(() => closed.push("L1"));
  const d2 = ctrl.pushBack(() => closed.push("L2"));
  ctrl.pushBack(() => closed.push("L3"));
  assert.equal(win.index, 4);

  // Close L2 via UI, keeping L3 alive on top.
  d2();
  await win.flush();
  assert.equal(win.index, 4);

  // Back #1 closes L3 AND skips dead L2 directly to L1!
  win.userBack();
  await win.flush();
  assert.deepEqual(closed, ["L3"]);
  assert.equal(win.index, 2);

  // Back #2 closes L1 -> Root.
  win.userBack();
  await win.flush();
  assert.deepEqual(closed, ["L3", "L1"]);
  assert.equal(win.index, 1);

  // Back #3 leaves directly to /prev.
  win.userBack();
  await win.flush();
  assert.equal(win.currentUrl, "/prev");
  ctrl.destroy();
});

test("simultaneous multi-layer UI closes in one tick collapse atomically to Root", async () => {
  const win = new SimulatedBrowserWindow([
    { url: "/prev", state: null },
    { url: "/", state: { __NA: true } },
  ]);
  const ctrl = createBackHistoryController(win, { sessionId: "s1" });
  ctrl.ensureRoot();

  const drop1 = ctrl.pushBack(() => {});
  const drop2 = ctrl.pushBack(() => {});
  const drop3 = ctrl.pushBack(() => {});
  assert.equal(win.index, 4);

  drop1();
  drop2();
  drop3();
  await win.flush();
  assert.equal(win.index, 1);

  win.userBack();
  await win.flush();
  assert.equal(win.currentUrl, "/prev");
  ctrl.destroy();
});

test("closing top layer and opening another in the same tick reuses slot in-place", async () => {
  const win = new SimulatedBrowserWindow([
    { url: "/prev", state: null },
    { url: "/", state: { __NA: true } },
  ]);
  const ctrl = createBackHistoryController(win, { sessionId: "s1" });
  ctrl.ensureRoot();

  const closed: string[] = [];
  const drop1 = ctrl.pushBack(() => closed.push("L1"));
  assert.equal(win.index, 2);

  drop1();
  ctrl.pushBack(() => closed.push("L2"));
  await win.flush();
  assert.equal(win.index, 2);
  assert.equal(win.entries.length, 3);

  win.userBack();
  await win.flush();
  assert.deepEqual(closed, ["L2"]);
  assert.equal(win.index, 1);

  win.userBack();
  await win.flush();
  assert.equal(win.currentUrl, "/prev");
  ctrl.destroy();
});

test("pushBack during inFlightGo queues and flushes after popstate settles (and can be dropped early)", async () => {
  const win = new SimulatedBrowserWindow([
    { url: "/prev", state: null },
    { url: "/", state: { __NA: true } },
  ]);
  const ctrl = createBackHistoryController(win, { sessionId: "s1" });
  ctrl.ensureRoot();

  const closed: string[] = [];
  ctrl.pushBack(() => closed.push("L1"));
  const drop2 = ctrl.pushBack(() => closed.push("L2"));

  // Start async prune (drop L2).
  drop2();
  await Promise.resolve(); // runs flushPrune microtask -> inFlightGo active, go(-1) queued!

  // Now before go(-1) settles: push L3 AND push+drop L4!
  ctrl.pushBack(() => closed.push("L3"));
  const drop4 = ctrl.pushBack(() => closed.push("L4"));
  drop4();

  await win.flush();
  assert.equal(win.index, 3); // [prev, Root, L1, L3]
  assert.deepEqual(closed, []);

  win.userBack();
  await win.flush();
  win.userBack();
  await win.flush();
  assert.deepEqual(closed, ["L3", "L1"]);
  assert.equal(win.index, 1);
  win.userBack();
  await win.flush();
  assert.equal(win.currentUrl, "/prev");
  ctrl.destroy();
});

test("user Back overshooting inFlightGo is never swallowed", async () => {
  const win = new SimulatedBrowserWindow([
    { url: "/prev", state: null },
    { url: "/", state: { __NA: true } },
  ]);
  const ctrl = createBackHistoryController(win, { sessionId: "s1" });
  ctrl.ensureRoot();

  const closed: string[] = [];
  ctrl.pushBack(() => closed.push("L1"));
  const drop2 = ctrl.pushBack(() => closed.push("L2"));

  drop2();
  await Promise.resolve(); // flushPrune queued go(-1) to L1
  // Simulate user hitting Back right behind it, so history lands at Root before settle
  win.userBack();
  await win.flush();

  assert.equal(win.index, 1);
  assert.deepEqual(closed, ["L1"]);
  assert.equal(ctrl.canGoBack(), false);

  win.userBack();
  await win.flush();
  assert.equal(win.currentUrl, "/prev");
  ctrl.destroy();
});

test("reload mid-session collapses back to Root so 1 Back press exits to /prev (and fresh tab collapses to index 0)", async () => {
  // With previous page:
  const win = new SimulatedBrowserWindow([
    { url: "/prev", state: null },
    { url: "/", state: { __NA: true } },
  ]);
  const c1 = createBackHistoryController(win, { sessionId: "s1" });
  c1.ensureRoot();
  c1.pushBack(() => {});
  c1.pushBack(() => {});
  c1.pushBack(() => {});
  assert.equal(win.index, 4);
  c1.destroy();

  // Simulated reload: fresh controller s2 on same history cursor (mrDepth: 3)
  const c2 = createBackHistoryController(win, { sessionId: "s2" });
  c2.ensureRoot();
  await win.flush();
  assert.equal(win.index, 1);
  assert.equal(c2.canGoBack(), false);

  win.userBack();
  await win.flush();
  assert.equal(win.currentUrl, "/prev");
  c2.destroy();

  // Fresh tab (index 0 is Root):
  const winFresh = new SimulatedBrowserWindow([{ url: "/", state: { __NA: true } }]);
  const f1 = createBackHistoryController(winFresh, { sessionId: "f1" });
  f1.ensureRoot();
  f1.pushBack(() => {});
  f1.pushBack(() => {});
  assert.equal(winFresh.index, 2);
  f1.destroy();

  const f2 = createBackHistoryController(winFresh, { sessionId: "f2" });
  f2.ensureRoot();
  await winFresh.flush();
  assert.equal(winFresh.index, 0);
  f2.destroy();
});

test("reload when original Root was evicted past history limit falls back cleanly via watchdog", async () => {
  // Suppose Root was evicted so index=0 already holds a stale layer with mrDepth=5
  const win = new SimulatedBrowserWindow([
    { url: "/", state: { __NA: true, mrSid: "evicted", mrRoot: false, mr: 9, mrDepth: 5 } },
  ], 0);
  const ctrl = createBackHistoryController(win, { sessionId: "s2", timeoutMs: 20 });
  ctrl.ensureRoot();
  const closed: string[] = [];
  ctrl.pushBack(() => closed.push("L1"));
  await new Promise((r) => setTimeout(r, 40));
  await win.flush();

  assert.equal(win.index, 1); // [newRoot, L1]
  win.userBack();
  await win.flush();
  assert.deepEqual(closed, ["L1"]);
  assert.equal(win.index, 0);
  ctrl.destroy();
});

test("legacy pre-mrSid history entries (dd16068b) are automatically skipped on Back to leave Mailroom", async () => {
  const win = new SimulatedBrowserWindow([
    { url: "/prev", state: null },
    { url: "/", state: { __NA: true, mrRoot: true } },
    { url: "/", state: { __NA: true, mrRoot: false, mr: 1 } },
    { url: "/", state: { __NA: true, mrRoot: false, mr: 2 } },
  ], 3);
  const ctrl = createBackHistoryController(win, { sessionId: "s_new" });
  ctrl.ensureRoot();
  await win.flush();

  // Single Back press from current Root skips legacy mr:1 and legacy mrRoot directly to /prev!
  win.userBack();
  await win.flush();
  assert.equal(win.index, 0);
  assert.equal(win.currentUrl, "/prev");
  ctrl.destroy();
});

test("Browser Forward into a previously popped entry reconciles back instead of stranding cursor", async () => {
  const win = new SimulatedBrowserWindow([
    { url: "/prev", state: null },
    { url: "/", state: { __NA: true } },
  ]);
  const ctrl = createBackHistoryController(win, { sessionId: "s1" });
  ctrl.ensureRoot();

  const closed: string[] = [];
  ctrl.pushBack(() => closed.push("Goals"));
  win.userBack();
  await win.flush();
  assert.equal(win.index, 1);

  // User presses Browser Forward onto popped Goals entry (idx=2)
  win.userForward();
  await win.flush();
  assert.equal(win.index, 1); // reconciled back to Root!

  win.userBack();
  await win.flush();
  assert.equal(win.currentUrl, "/prev");
  ctrl.destroy();
});

test("multi-step Back jump closes all skipped layers in LIFO order", async () => {
  const win = new SimulatedBrowserWindow([
    { url: "/prev", state: null },
    { url: "/", state: { __NA: true } },
  ]);
  const ctrl = createBackHistoryController(win, { sessionId: "s1" });
  ctrl.ensureRoot();

  const closed: string[] = [];
  ctrl.pushBack(() => closed.push("L1"));
  ctrl.pushBack(() => closed.push("L2"));
  ctrl.pushBack(() => closed.push("L3"));
  assert.equal(win.index, 4);

  // Jump straight from L3 back to L1 (delta -2)
  win.userJump(-2);
  await win.flush();
  assert.deepEqual(closed, ["L3", "L2"]);
  assert.equal(win.index, 2);

  // Next Back closes L1 -> Root, next leaves to /prev
  win.userBack();
  await win.flush();
  assert.deepEqual(closed, ["L3", "L2", "L1"]);
  win.userBack();
  await win.flush();
  assert.equal(win.currentUrl, "/prev");
  ctrl.destroy();
});

test("child pushBack called before ensureRoot initializes root automatically and preserves order", async () => {
  const winOrdered = new SimulatedBrowserWindow([
    { url: "/prev", state: null },
    { url: "/", state: { __NA: true, mrSid: "prevLoad", mrRoot: true, mrDepth: 0 } },
    { url: "/", state: { __NA: true, mrSid: "prevLoad", mrRoot: false, mr: 1, mrDepth: 1 } },
  ], 2);

  const ctrl = createBackHistoryController(winOrdered, { sessionId: "s_child_first" });
  const closed: string[] = [];
  // Child effect fires before parent useHistoryRoot():
  ctrl.pushBack(() => closed.push("restoredModal"));
  ctrl.ensureRoot(); // parent idempotent no-op
  await winOrdered.flush();

  // Collapsed prevLayer -> prevRoot (re-stamped as s_child_first Root), then pushed restoredModal!
  assert.equal(winOrdered.index, 2);
  assert.equal((winOrdered.currentState as Record<string, unknown>).mrDepth, 1);

  winOrdered.userBack();
  await winOrdered.flush();
  assert.deepEqual(closed, ["restoredModal"]);
  assert.equal(winOrdered.index, 1);

  winOrdered.userBack();
  await winOrdered.flush();
  assert.equal(winOrdered.currentUrl, "/prev");
  ctrl.destroy();
});

test("BFCache pageshow restores consistency when returning with stale active layers", async () => {
  const win = new SimulatedBrowserWindow([
    { url: "/prev", state: null },
    { url: "/", state: { __NA: true } },
  ]);
  const ctrl = createBackHistoryController(win, { sessionId: "s1" });
  ctrl.ensureRoot();

  const closed: string[] = [];
  ctrl.pushBack(() => closed.push("L1"));
  ctrl.pushBack(() => closed.push("L2"));
  // Simulate history index jumping to L1 while persisted pageshow fires
  win.index = 2;
  win.firePageShow(true);
  await win.flush();

  assert.deepEqual(closed, ["L2"]);
  win.userBack();
  await win.flush();
  assert.deepEqual(closed, ["L2", "L1"]);
  win.userBack();
  await win.flush();
  assert.equal(win.currentUrl, "/prev");
  ctrl.destroy();
});
