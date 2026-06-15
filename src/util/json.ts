import { readFileSync } from "node:fs";
import type { z } from "zod";
import { UserError } from "./errors.ts";
import { formatZodError } from "./zod.ts";

/**
 * Reads a file, JSON-parses it, and validates it against a zod schema, throwing a
 * {@link UserError} with a stable, label-prefixed message on either failure. The
 * shared core behind `readClient` / `readState` / `loadConfig` / `readProfile`.
 *
 * Callers handle the file-missing case themselves (some return null, some throw a
 * tailored message), so this assumes the file exists and is readable.
 */
export interface JsonFileLabels {
  /** Prefix for both error messages, e.g. `client.json at /path/to/client.json`. */
  label: string;
  /** Hint appended to the UserError when the file isn't valid JSON. */
  notJsonHint?: string;
  /** Hint appended to the UserError when the JSON fails schema validation. */
  invalidHint?: string;
}

export function readJsonFile<S extends z.ZodType>(
  path: string,
  schema: S,
  labels: JsonFileLabels,
): z.output<S> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new UserError(`${labels.label} is not valid JSON`, labels.notJsonHint);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new UserError(
      `${labels.label} is invalid: ${formatZodError(parsed.error)}`,
      labels.invalidHint,
    );
  }
  return parsed.data;
}
