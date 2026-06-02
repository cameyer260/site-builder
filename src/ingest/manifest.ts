import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { formatZodError } from "../config/schema.ts";
import { UserError } from "../util/errors.ts";

/**
 * `ingest/manifest.json` — the structured, inspectable index of everything
 * ingested for a Client. It is the handoff synthesize reads. All file paths are
 * relative to the `ingest/` directory for portability.
 */

export const AssetEntrySchema = z.object({
  url: z.string(),
  localPath: z.string(),
  kind: z.enum(["img", "og", "favicon"]),
  fromPage: z.string(),
  bytes: z.number().int().nonnegative(),
});

export const PageEntrySchema = z.object({
  url: z.string(),
  slug: z.string(),
  title: z.string(),
  markdownPath: z.string(),
  screenshots: z.record(z.string(), z.array(z.string())),
});

export const SiteEntrySchema = z.object({
  baseUrl: z.string(),
  pageCap: z.number().int().positive(),
  discovery: z.enum(["sitemap", "links", "single"]),
  pages: z.array(PageEntrySchema),
  assets: z.array(AssetEntrySchema),
});

export const DocEntrySchema = z.object({
  source: z.string(),
  kind: z.enum(["pdf", "docx", "txt", "md", "unknown"]),
  localPath: z.string().nullable(),
  chars: z.number().int().nonnegative(),
  error: z.string().optional(),
});

export const ImageEntrySchema = z.object({
  source: z.string(),
  localPath: z.string().nullable(),
  error: z.string().optional(),
});

export const IngestManifestSchema = z.object({
  createdAt: z.string(),
  inputs: z.object({
    url: z.string().optional(),
    docCount: z.number().int().nonnegative(),
    imageCount: z.number().int().nonnegative(),
    hasNotes: z.boolean(),
  }),
  site: SiteEntrySchema.optional(),
  docs: z.array(DocEntrySchema),
  images: z.array(ImageEntrySchema),
  notes: z.string().optional(),
});
export type IngestManifest = z.infer<typeof IngestManifestSchema>;
export type AssetEntry = z.infer<typeof AssetEntrySchema>;
export type DocEntry = z.infer<typeof DocEntrySchema>;
export type ImageEntry = z.infer<typeof ImageEntrySchema>;

export function writeManifest(path: string, manifest: IngestManifest): void {
  const validated = IngestManifestSchema.parse(manifest);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(validated, null, 2)}\n`);
}

export function readManifest(path: string): IngestManifest | null {
  if (!existsSync(path)) {
    return null;
  }
  const parsed = IngestManifestSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) {
    throw new UserError(`ingest manifest at ${path} is invalid: ${formatZodError(parsed.error)}`);
  }
  return parsed.data;
}
