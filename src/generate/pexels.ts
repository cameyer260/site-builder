import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Logger } from "../util/log.ts";

/**
 * **Image sourcing** tiers 2 + 3 (CONTEXT.md): the AI build declares each photo
 * slot it needs (intent + search keywords) in `generate/images.json` and
 * references the file at `src/assets/stock/<id>.jpg`; this module fetches the
 * top **Pexels** result per slot (tier 2, needs an API key) and falls back to
 * the curated Fallback Asset stock pack offline / when a fetch fails (tier 3),
 * so the file always exists before the `astro build` compile gate runs.
 */

const ORIENTATIONS = ["landscape", "portrait", "square"] as const;
type Orientation = (typeof ORIENTATIONS)[number];

export const ImageSlotSchema = z.object({
  /** Lowercase filename-safe slug; the file lands at `src/assets/stock/<id>.jpg`. */
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
  query: z.string().min(1),
  alt: z.string().optional(),
  orientation: z.enum(ORIENTATIONS).optional(),
});
export const ImagesManifestSchema = z.object({
  slots: z.array(ImageSlotSchema).default(() => []),
});
export type ImageSlot = z.infer<typeof ImageSlotSchema>;
export type ImagesManifest = z.infer<typeof ImagesManifestSchema>;

const FALLBACK_STOCK_DIR = fileURLToPath(new URL("../../assets/fallbacks/stock", import.meta.url));
const STOCK_SUBDIR = join("src", "assets", "stock");

/** Reads + validates the AI-written `generate/images.json`, or null if absent/invalid. */
export function readImagesManifest(path: string): ImagesManifest | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    const parsed = ImagesManifestSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** A Pexels `photos[0].src` variant URL, preferring an already-sized one. */
async function fetchFromPexels(
  slot: ImageSlot,
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<Buffer | null> {
  const params = new URLSearchParams({ query: slot.query, per_page: "1" });
  if (slot.orientation) {
    params.set("orientation", slot.orientation);
  }
  const res = await fetchImpl(`https://api.pexels.com/v1/search?${params}`, {
    headers: { Authorization: apiKey },
  });
  if (!res.ok) {
    return null;
  }
  const data = (await res.json()) as {
    photos?: { src?: Record<string, string> }[];
  };
  const src = data.photos?.[0]?.src;
  const url = src?.large2x ?? src?.large ?? src?.original;
  if (!url) {
    return null;
  }
  const img = await fetchImpl(url);
  if (!img.ok) {
    return null;
  }
  return Buffer.from(await img.arrayBuffer());
}

/** Picks the closest available fallback image for an orientation. */
function fallbackFor(orientation: Orientation | undefined): string | null {
  const order: Orientation[] = orientation
    ? [orientation, "landscape", "square", "portrait"]
    : ["landscape", "square", "portrait"];
  for (const name of order) {
    const candidate = join(FALLBACK_STOCK_DIR, `${name}.jpg`);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export interface ResolveImagesParams {
  siteDir: string;
  manifest: ImagesManifest;
  /** Pexels API key from config; absent → fallback pack only. */
  apiKey?: string;
  log: Logger;
  /** Injected for tests; defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

export interface ResolveImagesResult {
  fetched: number;
  fallback: number;
  missing: number;
}

/**
 * Materializes every declared image slot into `src/assets/stock/<id>.jpg`,
 * trying Pexels first (when a key is configured) and copying a Fallback Asset
 * otherwise. Never throws — a missing slot is reported so the caller can decide,
 * but in practice the fallback pack guarantees a file exists for the build.
 */
export async function resolveImages(params: ResolveImagesParams): Promise<ResolveImagesResult> {
  const { siteDir, manifest, apiKey, log } = params;
  const fetchImpl = params.fetchImpl ?? fetch;
  const result: ResolveImagesResult = { fetched: 0, fallback: 0, missing: 0 };
  if (manifest.slots.length === 0) {
    return result;
  }

  const stockDir = join(siteDir, STOCK_SUBDIR);
  mkdirSync(stockDir, { recursive: true });

  for (const slot of manifest.slots) {
    const dest = join(stockDir, `${slot.id}.jpg`);
    let buffer: Buffer | null = null;
    if (apiKey) {
      try {
        buffer = await fetchFromPexels(slot, apiKey, fetchImpl);
      } catch (err) {
        log.warn(
          `generate: Pexels fetch failed for "${slot.id}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (buffer) {
      writeFileSync(dest, buffer);
      result.fetched += 1;
      log.step(`generate: fetched stock image "${slot.id}" (${slot.query})`);
      continue;
    }

    const fb = fallbackFor(slot.orientation);
    if (fb) {
      copyFileSync(fb, dest);
      result.fallback += 1;
      log.step(
        `generate: stock image "${slot.id}" → fallback (${apiKey ? "fetch failed" : "no Pexels key"})`,
      );
    } else {
      result.missing += 1;
      log.warn(`generate: no image and no fallback for slot "${slot.id}"`);
    }
  }

  log.step(
    `generate: stock imagery — ${result.fetched} fetched, ${result.fallback} fallback, ${result.missing} missing`,
  );
  return result;
}
