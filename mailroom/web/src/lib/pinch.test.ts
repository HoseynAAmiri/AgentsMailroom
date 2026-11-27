import assert from "node:assert/strict";
import test from "node:test";
import type * as PinchModule from "./pinch";

const {
  clampZoom,
  computeElementScrollDelta,
  computeFractionalScrollTarget,
  computeImagePinchTransform,
} = (await import(new URL("./pinch.ts", import.meta.url).href)) as typeof PinchModule;

function approx(actual: number, expected: number, eps = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= eps, `expected ${actual} ~= ${expected}`);
}

test("computeImagePinchTransform keeps image coordinate fixed under pinch midpoint", () => {
  // Box [0, 400] x [0, 300], center (200, 150). Initial zoom=1, pan=(10, -20).
  // Pinch starts at (300, 210) -> offset from center = (+100, +60); image local = (+90, +80).
  // Pinch doubles distance and moves midpoint to (280, 190).
  const out = computeImagePinchTransform({
    startZoom: 1,
    startPanX: 10,
    startPanY: -20,
    startMidX: 300,
    startMidY: 210,
    startDist: 100,
    curMidX: 280,
    curMidY: 190,
    curDist: 200,
    boxLeft: 0,
    boxTop: 0,
    boxWidth: 400,
    boxHeight: 300,
    minZoom: 0.25,
    maxZoom: 8,
  });
  approx(out.zoom, 2);
  // Check pixel under (300, 210) at start lands at (280, 190) after zoom=2:
  // x_world = 200 + panX + 2 * (300 - 200 - 10) = 200 + panX + 180 = 280 => panX = -100
  // y_world = 150 + panY + 2 * (210 - 150 + 20) = 150 + panY + 160 = 190 => panY = -120
  approx(out.panX, -100);
  approx(out.panY, -120);
});

test("computeImagePinchTransform translates pan linearly on pure two-finger drag and clamps zoom", () => {
  const drag = computeImagePinchTransform({
    startZoom: 2,
    startPanX: 15,
    startPanY: -5,
    startMidX: 120,
    startMidY: 80,
    startDist: 80,
    curMidX: 155,
    curMidY: 105,
    curDist: 80,
    boxLeft: 20,
    boxTop: 10,
    boxWidth: 300,
    boxHeight: 200,
    minZoom: 0.25,
    maxZoom: 8,
  });
  approx(drag.zoom, 2);
  approx(drag.panX, 50);
  approx(drag.panY, 20);

  const clamped = computeImagePinchTransform({
    startZoom: 4,
    startPanX: 0,
    startPanY: 0,
    startMidX: 250,
    startMidY: 160,
    startDist: 50,
    curMidX: 250,
    curMidY: 160,
    curDist: 300,
    boxLeft: 0,
    boxTop: 0,
    boxWidth: 400,
    boxHeight: 300,
    minZoom: 0.25,
    maxZoom: 8,
  });
  approx(clamped.zoom, clampZoom(24, 0.25, 8));
  approx(clamped.panX, -50);
  approx(clamped.panY, -10);
});

test("computeElementScrollDelta anchors scaled PDF page point including centering-to-scroll transition", () => {
  // Before zoom: 300px wide page centered in 400px viewport -> left=50, width=300; point at clientX=290 -> relX=0.8.
  // After 2x zoom: page is 600px wide overflowing at scrollLeft=0 -> left=0, width=600.
  const delta = computeElementScrollDelta({
    elemLeft: 0,
    elemTop: -120,
    elemWidth: 600,
    elemHeight: 800,
    relX: 0.8,
    relY: 0.7,
    targetClientX: 290,
    targetClientY: 360,
  });
  // Current point clientX = 0 + 0.8 * 600 = 480; need scrollLeft += 190 to return to 290.
  // Current point clientY = -120 + 0.7 * 800 = 440; need scrollTop += 80 to return to 360.
  approx(delta.dScrollLeft, 190);
  approx(delta.dScrollTop, 80);
});

test("computeFractionalScrollTarget preserves text scroll position under pinch midpoint", () => {
  const out = computeFractionalScrollTarget({
    fracX: 0.4,
    fracY: 0.65,
    curScrollWidth: 1200,
    curScrollHeight: 4000,
    viewportRelX: 180,
    viewportRelY: 250,
  });
  approx(out.scrollLeft, 300);
  approx(out.scrollTop, 2350);

  const floored = computeFractionalScrollTarget({
    fracX: 0.05,
    fracY: 0.02,
    curScrollWidth: 400,
    curScrollHeight: 800,
    viewportRelX: 120,
    viewportRelY: 90,
  });
  approx(floored.scrollLeft, 0);
  approx(floored.scrollTop, 0);
});
