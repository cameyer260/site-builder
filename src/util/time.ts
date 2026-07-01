/** The current time as an ISO-8601 string — the one source of timestamps. */
export function nowIso(): string {
  return new Date().toISOString();
}

export interface UserDateTimeOptions {
  locale?: string | string[];
  timeZone?: string;
}

/**
 * Formats persisted timestamps for humans at CLI/log presentation boundaries.
 * Storage keeps ISO UTC strings so state remains sortable and portable.
 */
export function formatUserDateTime(value: string | Date, opts: UserDateTimeOptions = {}): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value instanceof Date ? String(value) : value;
  }
  return new Intl.DateTimeFormat(opts.locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: opts.timeZone,
  }).format(date);
}
