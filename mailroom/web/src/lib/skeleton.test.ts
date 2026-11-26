import assert from "node:assert/strict";
import test from "node:test";
import type * as SkeletonModule from "./skeleton";

const {
  resolveGoalsSkeletonMode,
  resolveMailSkeletonVariant,
} = (await import(new URL("./skeleton.ts", import.meta.url).href)) as typeof SkeletonModule;

test("resolveGoalsSkeletonMode parses stored mr-goals-view JSON and falls back cleanly", () => {
  assert.equal(resolveGoalsSkeletonMode(null), "goals");
  assert.equal(resolveGoalsSkeletonMode(""), "goals");
  assert.equal(resolveGoalsSkeletonMode("{bad-json"), "goals");
  assert.equal(resolveGoalsSkeletonMode("board"), "board");
  assert.equal(resolveGoalsSkeletonMode(JSON.stringify({ viewMode: "board", boardGoal: "G6" })), "board");
  assert.equal(resolveGoalsSkeletonMode(JSON.stringify({ viewMode: "decisions" })), "decisions");
  assert.equal(resolveGoalsSkeletonMode({ viewMode: "ready" }), "ready");
  assert.equal(resolveGoalsSkeletonMode({ viewMode: "active" }), "active");
  assert.equal(resolveGoalsSkeletonMode({ viewMode: "unknown" }), "goals");
});

test("resolveMailSkeletonVariant distinguishes status, tasks, and regular folders", () => {
  assert.equal(resolveMailSkeletonVariant(undefined), "standard");
  assert.equal(resolveMailSkeletonVariant("all"), "standard");
  assert.equal(resolveMailSkeletonVariant("inbox"), "standard");
  assert.equal(resolveMailSkeletonVariant("agent:a2"), "standard");
  assert.equal(resolveMailSkeletonVariant("tasks"), "tasks");
  assert.equal(resolveMailSkeletonVariant("status"), "status");
});
