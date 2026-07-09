import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { IngestManifest } from "../ingest/manifest.ts";
import type { Logger } from "../util/log.ts";
import type { AssetManifestEntry } from "./profile.ts";

/**
 * Asset classification + reconciliation (call A of synthesize). The vision
 * model classifies the captured image Assets into `context/assets.json`; this
 * module turns that into the canonical asset set under `context/assets/`,
 * dropping in a Fallback Asset for any required Asset (the logo) that's missing.
 */

/** Canonical Asset roles the model classifies into. */
export const ASSET_ROLES = [
  "logo",
  "hero",
  "team",
  "product",
  "gallery",
  "icon",
  "background",
  "photo",
  "other",
] as const;

/**
 * Roles capped at one kept Asset (there's only ever one brand mark, favicon,
 * page background, or hero image in play) — reconciliation keeps the first
 * and drops the rest, rather than trusting the classification prompt's
 * "choose at most one" instruction to hold.
 */
export const SINGLETON_ASSET_ROLES = new Set<(typeof ASSET_ROLES)[number]>([
  "logo",
  "icon",
  "background",
  "hero",
]);

/** Shape of the `context/assets.json` the model writes (call A). */
export const AssetClassificationSchema = z.object({
  assets: z.array(
    z.object({
      /** Must echo back the absolute path the candidate was listed under. */
      source: z.string(),
      role: z.enum(ASSET_ROLES),
      keep: z.boolean(),
      /** What the image depicts — read by the text-only `generate` stage, which never sees it. */
      description: z.string().optional(),
    }),
  ),
});
export type AssetClassification = z.infer<typeof AssetClassificationSchema>;

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".svg",
  ".ico",
]);

export interface AssetCandidate {
  /** Absolute path on disk (under `ingest/`). */
  absPath: string;
  /** Original source URL, when the Asset came from the crawl. */
  url?: string;
}

const FALLBACK_DIR = fileURLToPath(new URL("../../assets/fallbacks", import.meta.url));

/**
 * The image Assets eligible for classification: everything downloaded during
 * the crawl plus any user-provided images that landed on disk.
 */
export function candidateAssets(manifest: IngestManifest, ingestDir: string): AssetCandidate[] {
  const candidates: AssetCandidate[] = [];
  const seen = new Set<string>();
  const add = (localPath: string | null, url?: string): void => {
    if (!localPath) {
      return;
    }
    const abs = join(ingestDir, localPath);
    if (seen.has(abs) || !IMAGE_EXTENSIONS.has(extname(abs).toLowerCase())) {
      return;
    }
    seen.add(abs);
    candidates.push({ absPath: abs, url });
  };

  for (const asset of manifest.site?.assets ?? []) {
    add(asset.localPath, asset.url);
  }
  for (const image of manifest.images) {
    add(image.localPath);
  }
  return candidates;
}

/** Validates a parsed `context/assets.json` payload; null when it doesn't conform. */
export function parseClassification(raw: unknown): AssetClassification | null {
  const parsed = AssetClassificationSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Reads + validates the model-written `context/assets.json`, or null if absent/invalid. */
export function readClassification(contextDir: string): AssetClassification | null {
  const path = join(contextDir, "assets.json");
  if (!existsSync(path)) {
    return null;
  }
  try {
    return parseClassification(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

function canonicalName(role: string, ext: string, counters: Map<string, number>): string {
  const n = (counters.get(role) ?? 0) + 1;
  counters.set(role, n);
  const base = n === 1 ? role : `${role}-${n}`;
  return `${base}${ext || ".png"}`;
}

/**
 * Turns a classification into the canonical asset set under `context/assets/`:
 * copies each kept, on-disk Asset to a role-based name, and — when no logo was
 * found among the captured Assets — copies in the Fallback Asset. Returns the
 * asset manifest for `profile.json`. Best-effort and never throws; unreadable,
 * unmatched, extra-singleton, or (for multi-instance roles) undescribed
 * entries are skipped.
 */
export function reconcileAssets(input: {
  classification: AssetClassification;
  candidates: AssetCandidate[];
  contextDir: string;
  clientName: string;
  log: Logger;
}): AssetManifestEntry[] {
  const { classification, candidates, contextDir, clientName, log } = input;
  const assetsDir = join(contextDir, "assets");
  mkdirSync(assetsDir, { recursive: true });

  const byPath = new Map(candidates.map((c) => [c.absPath, c]));
  const counters = new Map<string, number>();
  const usedNames = new Set<string>();
  const seenSingletons = new Set<string>();
  const manifest: AssetManifestEntry[] = [];

  for (const entry of classification.assets) {
    if (!entry.keep) {
      continue;
    }
    if (SINGLETON_ASSET_ROLES.has(entry.role) && seenSingletons.has(entry.role)) {
      log.warn(
        `synthesize: dropping extra ${entry.role} asset (${entry.source}) — only one ${entry.role} is kept`,
      );
      continue;
    }
    // Multi-instance roles can have several kept Assets of the same role, and
    // `generate` never opens the image itself — without a description it has
    // no way to tell them apart or pick the right one for a given spot.
    if (!SINGLETON_ASSET_ROLES.has(entry.role) && !entry.description) {
      log.warn(
        `synthesize: dropping ${entry.role} asset (${entry.source}) — no description, and generate can't tell same-role Assets apart without one`,
      );
      continue;
    }
    const candidate = byPath.get(entry.source);
    if (!candidate || !existsSync(candidate.absPath)) {
      log.warn(`synthesize: classified asset not found on disk: ${entry.source}`);
      continue;
    }
    if (SINGLETON_ASSET_ROLES.has(entry.role)) {
      seenSingletons.add(entry.role);
    }
    let name = canonicalName(entry.role, extname(candidate.absPath).toLowerCase(), counters);
    while (usedNames.has(name)) {
      name = canonicalName(entry.role, extname(candidate.absPath).toLowerCase(), counters);
    }
    usedNames.add(name);
    copyFileSync(candidate.absPath, join(assetsDir, name));
    manifest.push({
      role: entry.role,
      file: `assets/${name}`,
      source: "captured",
      description: entry.description,
      originalUrl: candidate.url,
    });
  }

  if (!manifest.some((a) => a.role === "logo")) {
    const fallback = join(FALLBACK_DIR, "logo.svg");
    if (existsSync(fallback)) {
      copyFileSync(fallback, join(assetsDir, "logo.svg"));
      manifest.push({
        role: "logo",
        file: "assets/logo.svg",
        source: "fallback",
        description: `${clientName} logo`,
      });
      log.step("synthesize: no logo captured — using Fallback Asset");
    }
  }

  const captured = manifest.filter((a) => a.source === "captured").length;
  log.step(`synthesize: reconciled ${manifest.length} asset(s) (${captured} captured)`);
  return manifest;
}
