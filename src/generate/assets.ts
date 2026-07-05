import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, join } from "node:path";
import type { AssetManifestEntry } from "../synthesize/profile.ts";
import type { Logger } from "../util/log.ts";

/**
 * Placing the Client Profile's Assets into a Site Version (CONTEXT.md
 * "Asset", ADR-0011). Which Assets to keep was already decided once,
 * deterministically, back in `synthesize` (`reconcileAssets`) — `generate`
 * has nothing left to decide, only bytes left to move. So this copies every
 * Asset into the Site *before* the build engine call runs, the same "code
 * moves bytes, the Engine only decides intent" split `pexels.ts` uses for
 * stock imagery, just run in the other direction (pre- rather than
 * post-call, since these files and their names are already fixed). The build
 * prompt then only has to decide whether/where to reference an
 * already-staged file — the same shape of edit it already makes correctly
 * for stock photography — instead of locating and copying a binary file
 * across a directory boundary itself, which is the step that was silently
 * going unactioned.
 *
 * The `icon` role is the one exception: swapping a favicon has no creative
 * dimension (there's no "wrong subject" or "prefer a different look" call to
 * make), so `placeFavicon` does it unconditionally in code instead of asking
 * the build call to notice and wire it — it isn't staged into `captured/` or
 * listed in the build prompt at all.
 */

const CAPTURED_ASSETS_SUBDIR = join("src", "assets", "captured");

/** Where an Asset lands inside a Site Version, relative to its root. */
export function capturedAssetPath(assetFile: string): string {
  return join(CAPTURED_ASSETS_SUBDIR, basename(assetFile));
}

/** Copies every Profile Asset the build call should decide whether to use. */
export function placeCapturedAssets(
  contextDir: string,
  versionDir: string,
  assets: AssetManifestEntry[],
  log: Logger,
): void {
  const staged = assets.filter((a) => a.role !== "icon");
  if (staged.length === 0) {
    return;
  }
  mkdirSync(join(versionDir, CAPTURED_ASSETS_SUBDIR), { recursive: true });
  let placed = 0;
  for (const asset of staged) {
    const src = join(contextDir, asset.file);
    if (!existsSync(src)) {
      log.warn(`generate: Asset ${asset.role} (${asset.file}) missing from context/ — skipping`);
      continue;
    }
    copyFileSync(src, join(versionDir, capturedAssetPath(asset.file)));
    placed += 1;
  }
  log.step(`generate: staged ${placed} Asset(s) into ${CAPTURED_ASSETS_SUBDIR}/`);
}

const FAVICON_MIME_TYPES: Record<string, string> = {
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
};

/** The Kit's own placeholder favicon `<link>`, in `BaseLayout.astro`. */
const KIT_FAVICON_LINK = /<link rel="icon" type="[^"]*" href="\/favicon\.svg" \/>/;

/**
 * Swaps the Kit's placeholder favicon for the Client's own captured `icon`
 * Asset, when one exists — replacing `public/favicon.svg` with the real file
 * (under its own extension, since a captured icon is rarely an SVG) and
 * repointing `BaseLayout.astro`'s `<link rel="icon">` at it. No-ops (leaving
 * the Kit's default in place) when no icon was captured, its file is missing,
 * or its type isn't a usable favicon format.
 */
export function placeFavicon(
  contextDir: string,
  versionDir: string,
  assets: AssetManifestEntry[],
  log: Logger,
): void {
  const icon = assets.find((a) => a.role === "icon");
  if (!icon) {
    return;
  }
  const src = join(contextDir, icon.file);
  if (!existsSync(src)) {
    log.warn(`generate: Asset icon (${icon.file}) missing from context/ — skipping favicon`);
    return;
  }
  const ext = extname(icon.file).toLowerCase();
  const mime = FAVICON_MIME_TYPES[ext];
  if (!mime) {
    log.warn(`generate: captured icon has an unusable favicon type (${ext}) — skipping favicon`);
    return;
  }

  const layoutPath = join(versionDir, "src", "layouts", "BaseLayout.astro");
  if (!existsSync(layoutPath) || !KIT_FAVICON_LINK.test(readFileSync(layoutPath, "utf8"))) {
    log.warn("generate: could not find the Kit's favicon <link> to update — skipping favicon");
    return;
  }

  const publicDir = join(versionDir, "public");
  const oldFavicon = join(publicDir, "favicon.svg");
  const newFavicon = join(publicDir, `favicon${ext}`);
  if (existsSync(oldFavicon) && oldFavicon !== newFavicon) {
    rmSync(oldFavicon);
  }
  copyFileSync(src, newFavicon);
  writeFileSync(
    layoutPath,
    readFileSync(layoutPath, "utf8").replace(
      KIT_FAVICON_LINK,
      `<link rel="icon" type="${mime}" href="/favicon${ext}" />`,
    ),
  );
  log.step(`generate: replaced the Kit's favicon with the Client's own (favicon${ext})`);
}

/**
 * Best-effort evidence check, not a gate: warns when a captured Asset is never
 * referenced by any source file, so a silently-ignored logo/photo is at least
 * visible to the operator instead of vanishing unnoticed (ADR-0007's
 * evidence-not-gate philosophy, applied here too — a real design reason to
 * skip one is legitimate).
 *
 * Checks for a reference to the staged path, not the old byte-content scan:
 * `placeCapturedAssets` now stages every Asset unconditionally before the
 * build call runs, so mere presence under the Site Version proves nothing
 * about whether the Engine actually used it. The needle is
 * `captured/<basename>` rather than the bare basename so a same-named Kit
 * default (e.g. the Kit's own `logo.png`, still referenced via `./logo.png`)
 * can't be mistaken for a reference to the real one.
 *
 * Excludes `icon`: `placeFavicon` handles it deterministically in code (never
 * staged into `captured/`, so it would always show up as "unused" here) and
 * reports its own outcome.
 */
export function warnUnusedCapturedAssets(
  versionDir: string,
  assets: AssetManifestEntry[],
  log: Logger,
): void {
  const captured = assets.filter((a) => a.source === "captured" && a.role !== "icon");
  if (captured.length === 0) {
    return;
  }

  const srcDir = join(versionDir, "src");
  const sourceFiles = existsSync(srcDir)
    ? (readdirSync(srcDir, { recursive: true }) as string[])
        .filter((f) => /\.(astro|ts|tsx|mdx|css)$/.test(f))
        .map((f) => join(srcDir, f))
    : [];

  const isReferenced = (asset: AssetManifestEntry): boolean => {
    const needle = `captured/${basename(asset.file)}`;
    return sourceFiles.some((f) => {
      try {
        return readFileSync(f, "utf8").includes(needle);
      } catch {
        return false; // directories and unreadable entries just don't match
      }
    });
  };

  const unused = captured.filter((a) => !isReferenced(a));
  if (unused.length > 0) {
    const list = unused.map((a) => `${a.role} (${a.file})`).join(", ");
    log.warn(
      `generate: captured asset(s) staged but never referenced in the built Site — verify they were used: ${list}`,
    );
  }
}
