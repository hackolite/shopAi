/**
 * Returns true when an API error indicates that the live simulation session no
 * longer exists on the backend (HTTP 404 — e.g. the session was stopped or
 * reaped while the client kept its id). Errors thrown by `cadApi.request`
 * embed the HTTP status as a `[<status>]` prefix in the message.
 */
export function isSessionNotFoundError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('[404]');
}
