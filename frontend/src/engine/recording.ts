/**
 * Helpers for the 3D scene video recording pipeline.
 *
 * These functions are intentionally pure (no DOM/WebGL access) so they can be
 * unit-tested and reasoned about in isolation. The heavy lifting — capturing
 * the canvas stream and feeding a `MediaRecorder` — lives in the React
 * component, but the two decisions that drive recording *performance* (which
 * codec to use and at what resolution to capture) are extracted here.
 */

/**
 * Candidate MIME types, ordered from cheapest to most expensive to encode in
 * real time.  VP8 (and hardware-accelerated H.264 when available) encode much
 * more cheaply than VP9 software encoding, which competes with the WebGL render
 * loop on the main thread and is the main source of stutter while recording.
 * VP9 is kept only as a last-resort fallback.
 */
export const RECORDING_MIME_CANDIDATES = [
  'video/webm; codecs=vp8',
  'video/webm; codecs=h264',
  'video/webm',
  'video/webm; codecs=vp9',
] as const;

/**
 * Pick the first supported recording MIME type from {@link RECORDING_MIME_CANDIDATES}.
 *
 * @param isSupported Predicate matching `MediaRecorder.isTypeSupported`.
 * @returns The best supported MIME type, or `''` when none are supported (in
 *          which case the browser default should be used).
 */
export function pickRecordingMimeType(isSupported: (type: string) => boolean): string {
  return RECORDING_MIME_CANDIDATES.find((type) => isSupported(type)) ?? '';
}

/**
 * Longest edge (in pixels) that the recorded video is capped to. Encoding cost
 * scales with the pixel count of every captured frame, so bounding the longest
 * side keeps the real-time encoder (and the GPU read-back it triggers) cheap
 * regardless of the display size or device pixel ratio.
 */
export const RECORDING_MAX_LONG_SIDE_PX = 1280;

/**
 * Lowest device-pixel-ratio the recording is allowed to drop to. Prevents the
 * captured frame from becoming uselessly small on very large viewports.
 */
export const MIN_RECORDING_DPR = 0.5;

/**
 * Compute the device pixel ratio to render the scene at *while recording*.
 *
 * The canvas capture stream produces frames at the backing-store resolution,
 * which is `clientSize × devicePixelRatio`. On HiDPI displays that is up to 4×
 * the pixels of a 1× render, and encoding that many pixels in real time is the
 * dominant cause of recording lag. This clamps the pixel ratio so the captured
 * frame's longest side never exceeds {@link RECORDING_MAX_LONG_SIDE_PX}, while
 * never upscaling above the display's native ratio.
 *
 * @param clientWidth   CSS width of the canvas element, in pixels.
 * @param clientHeight  CSS height of the canvas element, in pixels.
 * @param devicePixelRatio The display's native device pixel ratio.
 * @param maxLongSidePx Maximum captured longest edge, in pixels.
 * @returns The pixel ratio to use for the recording render.
 */
export function computeRecordingDpr(
  clientWidth: number,
  clientHeight: number,
  devicePixelRatio: number,
  maxLongSidePx: number = RECORDING_MAX_LONG_SIDE_PX,
): number {
  const nativeDpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const longSide = Math.max(clientWidth, clientHeight);
  if (!Number.isFinite(longSide) || longSide <= 0) {
    return nativeDpr;
  }
  // Pixel ratio at which the backing-store longest side equals maxLongSidePx.
  const capFromMax = maxLongSidePx / longSide;
  // Never upscale beyond the native ratio; never drop below the floor.
  return Math.max(Math.min(nativeDpr, capFromMax), MIN_RECORDING_DPR);
}
