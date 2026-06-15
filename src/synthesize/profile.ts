import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { UserError } from "../util/errors.ts";
import { readJsonFile } from "../util/json.ts";
import { CHECKLIST } from "./checklist.ts";

/**
 * The **Client Profile** sidecar, `context/profile.json` (CONTEXT.md). The
 * human-readable `profile.md` is the primary artifact `generate` consumes; this
 * JSON holds the machine-checkable facts: each Checklist field with its Field
 * status, the contact facts, and the reconciled asset manifest.
 */

/** Provenance of a Profile answer (CONTEXT.md "Field status"). */
export const FIELD_STATUSES = ["Known", "Guessed", "Unknown"] as const;
export const FieldStatusSchema = z.enum(FIELD_STATUSES);
export type FieldStatus = z.infer<typeof FieldStatusSchema>;

/**
 * A Checklist answer. Many fields are naturally multi-valued (services, socials,
 * testimonials), so the synthesizing model legitimately returns lists/objects as
 * well as scalars. We normalize all of those to `string | string[] | null` —
 * keeping list structure (useful to `generate`) while staying schema-stable.
 */
export const FieldValueSchema = z.preprocess(
  (raw) => {
    if (raw === null || raw === undefined) {
      return null;
    }
    if (typeof raw === "string") {
      return raw;
    }
    const toText = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));
    if (Array.isArray(raw)) {
      return raw.map(toText);
    }
    if (typeof raw === "object") {
      return Object.entries(raw as Record<string, unknown>).map(([k, v]) => `${k}: ${toText(v)}`);
    }
    return String(raw);
  },
  z.union([z.string(), z.array(z.string()), z.null()]),
);
export type FieldValue = z.infer<typeof FieldValueSchema>;

export const ProfileFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  /** The answer; null when Unknown. A scalar or a list for multi-valued fields. */
  value: FieldValueSchema,
  status: FieldStatusSchema,
  /** Optional rationale, chiefly for Guessed values flagged for later review. */
  note: z.string().optional(),
});
export type ProfileField = z.infer<typeof ProfileFieldSchema>;

/** Renders a (possibly list) field value as a single human-readable string. */
export function displayFieldValue(value: FieldValue): string {
  if (value === null) {
    return "";
  }
  return Array.isArray(value) ? value.join(", ") : value;
}

export const ContactSchema = z.object({
  email: z.string().optional(),
  phone: z.string().optional(),
  address: z.string().optional(),
});

/** One classified, canonically-named Asset (or a Fallback Asset). */
export const AssetManifestEntrySchema = z.object({
  role: z.string(),
  /** Path relative to `context/` (e.g. `assets/logo.png`). */
  file: z.string(),
  source: z.enum(["captured", "fallback"]),
  alt: z.string().optional(),
  originalUrl: z.string().optional(),
});
export type AssetManifestEntry = z.infer<typeof AssetManifestEntrySchema>;

export const ProfileSchema = z.object({
  client: z.string(),
  generatedAt: z.string().optional(),
  fields: z.array(ProfileFieldSchema),
  contact: ContactSchema.default(() => ContactSchema.parse({})),
  assets: z.array(AssetManifestEntrySchema).default(() => []),
});
export type Profile = z.infer<typeof ProfileSchema>;

/** Counts of each Field status, for logging and the milestone check. */
export function statusCounts(fields: ProfileField[]): Record<FieldStatus, number> {
  const counts: Record<FieldStatus, number> = { Known: 0, Guessed: 0, Unknown: 0 };
  for (const field of fields) {
    counts[field.status] += 1;
  }
  return counts;
}

/**
 * Reads and validates a `profile.json` written by the synthesizing model.
 * Throws a UserError on missing/invalid input so the stage fails loudly (the
 * AI artifact contract is asserted on shape, per the testing posture).
 */
export function readProfile(path: string): Profile {
  if (!existsSync(path)) {
    throw new UserError(`synthesize: expected profile.json at ${path}, but it was not written`);
  }
  const profile = readJsonFile(path, ProfileSchema, {
    label: `synthesize: profile.json at ${path}`,
  });
  assertChecklistCoverage(path, profile.fields);
  return profile;
}

export function writeProfile(path: string, profile: Profile): void {
  const validated = ProfileSchema.parse(profile);
  assertChecklistCoverage(path, validated.fields);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(validated, null, 2)}\n`);
}

function assertChecklistCoverage(path: string, fields: ProfileField[]): void {
  const expected = CHECKLIST.map((item) => item.key);
  const expectedSet = new Set(expected);
  const seen = new Set<string>();
  const missing: string[] = [];
  const duplicates: string[] = [];
  const unknown: string[] = [];

  for (const field of fields) {
    if (seen.has(field.key)) {
      duplicates.push(field.key);
    }
    seen.add(field.key);
    if (!expectedSet.has(field.key)) {
      unknown.push(field.key);
    }
  }

  for (const key of expected) {
    if (!seen.has(key)) {
      missing.push(key);
    }
  }

  if (missing.length > 0 || duplicates.length > 0 || unknown.length > 0) {
    const parts = [
      missing.length > 0 ? `missing: ${missing.join(", ")}` : "",
      duplicates.length > 0 ? `duplicate: ${duplicates.join(", ")}` : "",
      unknown.length > 0 ? `unknown: ${unknown.join(", ")}` : "",
    ].filter(Boolean);
    throw new UserError(
      `synthesize: profile.json at ${path} does not match Checklist (${parts.join("; ")})`,
    );
  }
}
