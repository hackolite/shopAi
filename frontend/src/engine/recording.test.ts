/**
 * Unit tests for the recording helpers.
 *
 * Run with: npx vitest run
 */
import { describe, it, expect } from 'vitest';
import {
  pickRecordingMimeType,
  computeRecordingDpr,
  RECORDING_MIME_CANDIDATES,
  RECORDING_MAX_LONG_SIDE_PX,
  MIN_RECORDING_DPR,
} from './recording';

describe('pickRecordingMimeType', () => {
  it('prefers VP8 when everything is supported', () => {
    expect(pickRecordingMimeType(() => true)).toBe('video/webm; codecs=vp8');
  });

  it('falls back to the first supported candidate in order', () => {
    const supported = new Set(['video/webm', 'video/webm; codecs=vp9']);
    expect(pickRecordingMimeType((t) => supported.has(t))).toBe('video/webm');
  });

  it('falls back to VP9 as a last resort', () => {
    expect(pickRecordingMimeType((t) => t === 'video/webm; codecs=vp9')).toBe(
      'video/webm; codecs=vp9',
    );
  });

  it('returns an empty string when nothing is supported', () => {
    expect(pickRecordingMimeType(() => false)).toBe('');
  });

  it('only ever returns a listed candidate', () => {
    const picked = pickRecordingMimeType(() => true);
    expect(RECORDING_MIME_CANDIDATES).toContain(picked);
  });
});

describe('computeRecordingDpr', () => {
  it('caps the longest side to the maximum on a HiDPI display', () => {
    // 1600 CSS px wide at 2× would capture 3200px; cap to 1280.
    const dpr = computeRecordingDpr(1600, 900, 2, 1280);
    expect(dpr).toBeCloseTo(1280 / 1600);
    expect(1600 * dpr).toBeCloseTo(1280);
  });

  it('caps below 1× when the viewport is larger than the max on a 1× display', () => {
    const dpr = computeRecordingDpr(1920, 1080, 1, 1280);
    expect(dpr).toBeCloseTo(1280 / 1920);
    expect(1920 * dpr).toBeCloseTo(1280);
  });

  it('never upscales beyond the native device pixel ratio', () => {
    // Small viewport: cap would allow >1, but native is 1.
    const dpr = computeRecordingDpr(640, 480, 1, 1280);
    expect(dpr).toBe(1);
  });

  it('respects the native ratio when it is already below the cap', () => {
    const dpr = computeRecordingDpr(800, 600, 1.5, 1280);
    // cap = 1280/800 = 1.6, native 1.5 is lower and wins.
    expect(dpr).toBe(1.5);
  });

  it('does not drop below the floor for very large viewports', () => {
    const dpr = computeRecordingDpr(10000, 8000, 2, 1280);
    expect(dpr).toBe(MIN_RECORDING_DPR);
  });

  it('falls back to the native ratio for degenerate sizes', () => {
    expect(computeRecordingDpr(0, 0, 2, 1280)).toBe(2);
    expect(computeRecordingDpr(NaN, NaN, 1.75, 1280)).toBe(1.75);
  });

  it('treats a non-positive device pixel ratio as 1×', () => {
    expect(computeRecordingDpr(0, 0, 0, 1280)).toBe(1);
  });

  it('uses the default maximum long side when omitted', () => {
    const dpr = computeRecordingDpr(RECORDING_MAX_LONG_SIDE_PX * 2, 100, 2);
    expect(dpr).toBeCloseTo(0.5);
  });
});
