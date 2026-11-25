// Composition geometry lives next to the FFmpeg filter graph so there is a
// single source of truth. This module re-exports it for callers that only need
// layout numbers (e.g. a future branded layout).
export { computeLayout, fitInside } from "./ffmpeg.js";

export function getLayout(config) {
  return { canvas: config.canvas, composition: config.composition };
}

