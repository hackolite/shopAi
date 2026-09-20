import { describe, expect, it } from 'vitest';
import { shouldUseLlmPath } from './assistantRouting';

describe('assistantRouting', () => {
  it('falls back to the local assistant when the provider preflight is unreachable', () => {
    expect(shouldUseLlmPath({
      enabled: true,
      reachable: false,
      status: 'unreachable',
      message: 'down',
    })).toBe(false);
  });

  it('uses the LLM path when the provider is enabled and reachable', () => {
    expect(shouldUseLlmPath({
      enabled: true,
      reachable: true,
      status: 'ready',
      message: 'ok',
    })).toBe(true);
  });
});
