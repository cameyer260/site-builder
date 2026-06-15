/** The current time as an ISO-8601 string — the one source of timestamps. */
export function nowIso(): string {
  return new Date().toISOString();
}
