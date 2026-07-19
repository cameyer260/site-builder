import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
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

// ---- Candidate de-duplication (ADR-0016) -----------------------------------
//
// The crawler records one URL per <img>, so the same original image served at
// many registered WordPress sizes / theme crops across pages becomes many
// distinct Candidates. `dedupeCandidates` collapses each original down to a
// single best representative before classification ever sees the list — see
// ADR-0016 for the full rationale and the production numbers that motivated it.

/** WordPress/retina derivative suffixes `canonicalStem` strips, anchored at the end. */
const DERIVATIVE_SUFFIXES: readonly RegExp[] = [
  /-\d{1,5}x\d{1,5}$/, // WP core resize, e.g. -150x150, -768x512
  /-scaled$/, // WP big-image auto-scale
  /-rotated$/, // WP auto-rotate
  /-e\d{13}$/, // WP media-editor edit, -e{13-digit timestamp}
  /@2x$/, // retina
  /-2x$/, // retina
];

/**
 * Strips WordPress/retina derivative suffixes off a bare filename stem
 * (no extension), repeatedly, until none apply. Deliberately does NOT strip a
 * trailing upload counter (`-1`, `-2`, …): in WordPress that marks a genuinely
 * distinct upload whose name collided, and our own downloader (`uniqueName`,
 * `src/util/names.ts`) appends the same suffix on our own stem collisions —
 * stripping it would wrongly fold different images together.
 */
export function canonicalStem(base: string): string {
  let stem = base;
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of DERIVATIVE_SUFFIXES) {
      const stripped = stem.replace(suffix, "");
      if (stripped !== stem) {
        stem = stripped;
        changed = true;
      }
    }
  }
  return stem;
}

/** Size/crop vocabulary a derivative suffix tail may consist of (case-insensitive). */
const DERIVATIVE_TOKENS = new Set([
  "thumb",
  "thumbnail",
  "small",
  "medium",
  "large",
  "full",
  "fullwidth",
  "wide",
  "tall",
  "square",
  "portrait",
  "landscape",
  "gallery",
  "crop",
  "cropped",
  "grid",
  "masonry",
  "scaled",
  "rotated",
  "retina",
  "mobile",
  "desktop",
  "preview",
  "thegem",
]);

const DIMENSION_TOKEN = /\d+x\d+/i;
/** An opaque cache-bust / image-optimization hash appended to a filename. */
const OPAQUE_HASH_TOKEN = /^[a-z0-9]{20,}$/i;

/**
 * True when `rest` — the hyphen-delimited tail after a bare original's
 * stem — reads as a derivative marker rather than a distinct content word:
 * a WxH dimension token, an opaque cache-bust hash, or (when split on `-`) any
 * token drawn from the size/crop vocab. Deliberately conservative: a content
 * word like `left` must NOT match, so `hero-left.jpg` never folds into
 * `hero.jpg` just because it shares a prefix.
 */
export function looksLikeDerivativeSuffix(rest: string): boolean {
  if (DIMENSION_TOKEN.test(rest) || OPAQUE_HASH_TOKEN.test(rest)) {
    return true;
  }
  return rest.split("-").some((token) => DERIVATIVE_TOKENS.has(token.toLowerCase()));
}

/** The trailing `-WxH` dimensions off a bare filename stem (no extension), or null. */
export function parseSizeSuffix(base: string): { w: number; h: number } | null {
  const match = base.match(/-(\d{1,5})x(\d{1,5})$/);
  if (!match) {
    return null;
  }
  return { w: Number(match[1]), h: Number(match[2]) };
}

/** Raster extensions eligible for the size floor; SVG/ICO are exempt as legitimately-tiny vectors/icons. */
const RASTER_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
/** Below this byte count, a raster image is a tracking pixel/spacer, not real content. */
const MIN_RASTER_BYTES = 1500;
/** Below this pixel size (on the larger side), a parsed WxH derivative is too small to be useful. */
const MIN_DIMENSION = 32;

interface EnrichedCandidate {
  candidate: AssetCandidate;
  name: string;
  bytes: number;
  hash: string;
}

function stemOf(name: string): string {
  const ext = extname(name);
  return ext ? name.slice(0, -ext.length) : name;
}

/**
 * Deterministic, dependency-free de-duplication of image Asset Candidates,
 * run before the vision-classification engine call (ADR-0016). Client sites —
 * especially WordPress — serve the same original image at many registered
 * sizes / theme crops across pages, so a 25-page site can produce 100+
 * Candidates that are mostly derivatives of a few dozen originals; handing all
 * of them to classification inflates that call's cost and reliability for no
 * benefit, since the derivatives carry no information the original lacks.
 * Reading each Candidate's bytes off disk is the only impure step.
 *
 * In order:
 * 1. Exact byte-hash dedup (sha1) — catches identical bytes under any name.
 * 2. WordPress-derivative identity grouping — `canonicalStem` recovers each
 *    original's bare stem, and a conservative bare-original prefix rule folds
 *    `{stem}-{suffix}` into a captured bare `{stem}` Candidate when the suffix
 *    reads as a derivative token. Keeps the largest-byte survivor per group.
 * 3. Size floor — drops tracking-pixel-sized rasters and undersized `-WxH`
 *    derivatives.
 *
 * A Candidate that can't be read off disk is kept untouched and excluded from
 * every grouping/floor step above — never dropped for an IO error.
 */
export function dedupeCandidates(candidates: AssetCandidate[]): AssetCandidate[] {
  const keep = new Set<AssetCandidate>();
  const enriched: EnrichedCandidate[] = [];

  for (const candidate of candidates) {
    const name = basename(candidate.url ?? candidate.absPath);
    try {
      const bytes = readFileSync(candidate.absPath);
      enriched.push({
        candidate,
        name,
        bytes: bytes.length,
        hash: createHash("sha1").update(bytes).digest("hex"),
      });
    } catch {
      keep.add(candidate); // unreadable: keep as its own singleton, never drop
    }
  }

  // 1. Exact byte-hash dedup: within a hash group, keep the shortest name.
  const byHash = new Map<string, EnrichedCandidate>();
  for (const item of enriched) {
    const existing = byHash.get(item.hash);
    if (!existing || item.name.length < existing.name.length) {
      byHash.set(item.hash, item);
    }
  }
  const hashSurvivors = [...byHash.values()];

  // 2. Identity grouping: primary key is canonicalStem; a union step then folds
  // a derivative's canon into its bare original's canon when the tail reads as
  // a derivative suffix (tiny union-find over the small set of distinct canons).
  const canonOf = new Map<EnrichedCandidate, string>();
  for (const item of hashSurvivors) {
    canonOf.set(item, canonicalStem(stemOf(item.name)));
  }
  const distinctCanons = [...new Set(canonOf.values())];

  const parent = new Map<string, string>(distinctCanons.map((c) => [c, c]));
  const find = (s: string): string => {
    let root = s;
    while (parent.get(root) !== root) {
      root = parent.get(root) as string;
    }
    parent.set(s, root);
    return root;
  };
  for (const cA of distinctCanons) {
    for (const cB of distinctCanons) {
      if (
        cA !== cB &&
        cB.startsWith(`${cA}-`) &&
        looksLikeDerivativeSuffix(cB.slice(cA.length + 1))
      ) {
        parent.set(find(cB), find(cA));
      }
    }
  }

  const groups = new Map<string, EnrichedCandidate[]>();
  for (const item of hashSurvivors) {
    const root = find(canonOf.get(item) as string);
    const group = groups.get(root);
    if (group) {
      group.push(item);
    } else {
      groups.set(root, [item]);
    }
  }

  const identitySurvivors: EnrichedCandidate[] = [];
  for (const group of groups.values()) {
    identitySurvivors.push(
      group.reduce((best, item) =>
        item.bytes > best.bytes ||
        (item.bytes === best.bytes && item.name.length < best.name.length)
          ? item
          : best,
      ),
    );
  }

  // 3. Size floor.
  for (const item of identitySurvivors) {
    const ext = extname(item.name).toLowerCase();
    if (RASTER_EXTENSIONS.has(ext) && item.bytes < MIN_RASTER_BYTES) {
      continue;
    }
    const size = parseSizeSuffix(stemOf(item.name));
    if (size && Math.max(size.w, size.h) < MIN_DIMENSION) {
      continue;
    }
    keep.add(item.candidate);
  }

  return candidates.filter((c) => keep.has(c));
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
