export function clampZoom(zoom: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, zoom));
}

export interface ImagePinchInput {
  startZoom: number;
  startPanX: number;
  startPanY: number;
  startMidX: number;
  startMidY: number;
  startDist: number;
  curMidX: number;
  curMidY: number;
  curDist: number;
  boxLeft: number;
  boxTop: number;
  boxWidth: number;
  boxHeight: number;
  minZoom: number;
  maxZoom: number;
}

/** Compute centered CSS transform `(zoom, panX, panY)` keeping the pinch-start pixel under the current pinch midpoint. */
export function computeImagePinchTransform(p: ImagePinchInput): {
  zoom: number;
  panX: number;
  panY: number;
} {
  const safeStartDist = Math.max(10, p.startDist);
  const zoom = clampZoom((p.startZoom * p.curDist) / safeStartDist, p.minZoom, p.maxZoom);
  const k = zoom / p.startZoom;
  const cx = p.boxLeft + p.boxWidth / 2;
  const cy = p.boxTop + p.boxHeight / 2;
  const ox0 = p.startMidX - cx;
  const oy0 = p.startMidY - cy;
  const ox1 = p.curMidX - cx;
  const oy1 = p.curMidY - cy;
  return {
    zoom,
    panX: ox1 - (ox0 - p.startPanX) * k,
    panY: oy1 - (oy0 - p.startPanY) * k,
  };
}

export interface ElementScrollDeltaInput {
  elemLeft: number;
  elemTop: number;
  elemWidth: number;
  elemHeight: number;
  relX: number;
  relY: number;
  targetClientX: number;
  targetClientY: number;
}

/** Compute scroll adjustment after an element's layout size changes so `(relX, relY)` lands at `(targetClientX, targetClientY)`. */
export function computeElementScrollDelta(p: ElementScrollDeltaInput): {
  dScrollLeft: number;
  dScrollTop: number;
} {
  const curClientX = p.elemLeft + p.relX * p.elemWidth;
  const curClientY = p.elemTop + p.relY * p.elemHeight;
  return {
    dScrollLeft: curClientX - p.targetClientX,
    dScrollTop: curClientY - p.targetClientY,
  };
}

export interface FractionalScrollTargetInput {
  fracX: number;
  fracY: number;
  curScrollWidth: number;
  curScrollHeight: number;
  viewportRelX: number;
  viewportRelY: number;
}

/** Compute target `(scrollLeft, scrollTop)` preserving fractional content coordinates under a viewport offset. */
export function computeFractionalScrollTarget(p: FractionalScrollTargetInput): {
  scrollLeft: number;
  scrollTop: number;
} {
  return {
    scrollLeft: Math.max(0, p.fracX * p.curScrollWidth - p.viewportRelX),
    scrollTop: Math.max(0, p.fracY * p.curScrollHeight - p.viewportRelY),
  };
}
