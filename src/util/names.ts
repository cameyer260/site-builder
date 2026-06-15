/**
 * Returns a name unique within `used` by appending `-1`, `-2`, … (before the
 * optional `ext`) until it's free, then records the chosen name in `used`. The
 * shared de-dup behind the crawl/inspect page slugs and ingest asset filenames
 * (ADR-0009).
 */
export function uniqueName(base: string, used: Set<string>, ext = ""): string {
  let candidate = `${base}${ext}`;
  let n = 1;
  while (used.has(candidate)) {
    candidate = `${base}-${n}${ext}`;
    n += 1;
  }
  used.add(candidate);
  return candidate;
}
