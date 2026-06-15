import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { uniqueName } from "../util/names.ts";

/** The asset sources v1 captures (CONTEXT.md > Asset; roadmap defers the rest). */
export type AssetKind = "img" | "og" | "favicon";

export interface AssetSource {
  url: string;
  kind: AssetKind;
}

export interface DownloadedAsset {
  url: string;
  /** Absolute path on disk. */
  path: string;
  kind: AssetKind;
  fromPage: string;
  bytes: number;
}

const MAX_ASSET_BYTES = 15 * 1024 * 1024;

const CONTENT_TYPE_EXT: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "image/x-icon": ".ico",
  "image/vnd.microsoft.icon": ".ico",
};

/** Picks a unique, sanitized filename for an asset URL within `used`. */
function assetFileName(url: string, contentType: string | null, used: Set<string>): string {
  let stem = "asset";
  let ext = "";
  try {
    const pathname = new URL(url).pathname;
    const base = basename(pathname);
    if (base) {
      ext = extname(base);
      stem = (ext ? base.slice(0, -ext.length) : base) || "asset";
    }
  } catch {
    // keep defaults
  }
  if (!ext && contentType) {
    ext = CONTENT_TYPE_EXT[contentType.split(";")[0]?.trim() ?? ""] ?? "";
  }
  stem = stem.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "asset";

  return uniqueName(stem, used, ext);
}

/**
 * Downloads one asset into `destDir`, returning null on any failure (network,
 * empty, oversized) so a single bad asset never fails ingest.
 */
export async function downloadAsset(
  source: AssetSource,
  fromPage: string,
  destDir: string,
  used: Set<string>,
): Promise<DownloadedAsset | null> {
  if (source.url.startsWith("data:")) {
    return null; // inline data URIs aren't useful as captured Assets
  }
  try {
    const res = await fetch(source.url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      return null;
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_ASSET_BYTES) {
      return null;
    }
    const name = assetFileName(source.url, res.headers.get("content-type"), used);
    mkdirSync(destDir, { recursive: true });
    const path = join(destDir, name);
    await writeFile(path, bytes);
    return { url: source.url, path, kind: source.kind, fromPage, bytes: bytes.length };
  } catch {
    return null;
  }
}
