import type { LlmAssistantStatus } from '../api/cad';

export function shouldUseLlmPath(status: LlmAssistantStatus): boolean {
  return status.enabled && status.reachable;
}
