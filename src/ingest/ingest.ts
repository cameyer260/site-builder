import { existsSync, mkdirSync } from "node:fs";
import { copyFile, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import type { Config } from "../config/schema.ts";
import { withBrowser } from "../playwright/browser.ts";
import { profilesFromConfig } from "../playwright/screenshot.ts";
import type { ClientInputs } from "../storage/client.ts";
import type { ClientPaths } from "../storage/layout.ts";
import type { Logger } from "../util/log.ts";
import { nowIso } from "../util/time.ts";
import { downloadAsset } from "./assets.ts";
import { crawlSite } from "./crawl.ts";
import { docKind, extractDoc } from "./docs.ts";
import {
  type AssetEntry,
  type DocEntry,
  type ImageEntry,
  type IngestManifest,
  writeManifest,
} from "./manifest.ts";

export interface IngestParams {
  paths: ClientPaths;
  inputs: ClientInputs;
  config: Config;
  pageCap: number;
  log: Logger;
}

/**
 * The real `ingest` stage (build-plan Phase 2): gathers raw material from every
 * provided Input into the `ingest/` layout and writes `manifest.json`. Pure
 * code, no AI. The orchestrator has already cleared `ingest/` on resume.
 */
export async function runIngest(params: IngestParams): Promise<IngestManifest> {
  const { paths, inputs, config, pageCap, log } = params;
  const ingestDir = paths.ingest;
  mkdirSync(ingestDir, { recursive: true });
  const rel = (absolute: string): string => relative(ingestDir, absolute);

  const manifest: IngestManifest = {
    createdAt: nowIso(),
    inputs: {
      url: inputs.url,
      docCount: inputs.docs.length,
      imageCount: inputs.images.length,
      hasNotes: Boolean(inputs.notes),
    },
    docs: [],
    images: [],
  };

  if (inputs.url) {
    manifest.site = await ingestSite(inputs.url, ingestDir, config, pageCap, log, rel);
  }
  if (inputs.docs.length > 0) {
    manifest.docs = await ingestDocs(inputs.docs, ingestDir, log, rel);
  }
  if (inputs.images.length > 0) {
    manifest.images = await ingestImages(inputs.images, ingestDir, log, rel);
  }
  if (inputs.notes) {
    const notesPath = join(ingestDir, "notes.md");
    await writeFile(notesPath, `${inputs.notes}\n`);
    manifest.notes = rel(notesPath);
    log.step("ingest: wrote notes");
  }

  writeManifest(join(ingestDir, "manifest.json"), manifest);
  return manifest;
}

async function ingestSite(
  url: string,
  ingestDir: string,
  config: Config,
  pageCap: number,
  log: Logger,
  rel: (p: string) => string,
): Promise<IngestManifest["site"]> {
  log.step(`ingest: crawling ${url} (page cap ${pageCap})`);
  const siteDir = join(ingestDir, "site");
  const pagesDir = join(siteDir, "pages");
  const screenshotsDir = join(siteDir, "screenshots");
  const assetsDir = join(siteDir, "assets");
  const profiles = profilesFromConfig(config.viewports);

  return withBrowser(async (browser) => {
    const crawl = await crawlSite(browser, url, profiles, screenshotsDir, pageCap, log);

    const usedAssetNames = new Set<string>();
    const seenAssetUrls = new Set<string>();
    const assets: AssetEntry[] = [];
    const pages: NonNullable<IngestManifest["site"]>["pages"] = [];

    for (const page of crawl.pages) {
      mkdirSync(pagesDir, { recursive: true });
      const mdPath = join(pagesDir, `${page.slug}.md`);
      const front = `---\nurl: ${page.url}\ntitle: ${JSON.stringify(page.title)}\n---\n\n`;
      await writeFile(mdPath, `${front}${page.markdown}\n`);

      for (const source of page.assets) {
        if (seenAssetUrls.has(source.url)) {
          continue;
        }
        seenAssetUrls.add(source.url);
        const downloaded = await downloadAsset(source, page.url, assetsDir, usedAssetNames);
        if (downloaded) {
          assets.push({
            url: downloaded.url,
            localPath: rel(downloaded.path),
            kind: downloaded.kind,
            fromPage: downloaded.fromPage,
            bytes: downloaded.bytes,
          });
        }
      }

      const screenshots: Record<string, string[]> = {};
      for (const [profile, files] of Object.entries(page.screenshots)) {
        screenshots[profile] = files.map(rel);
      }
      pages.push({
        url: page.url,
        slug: page.slug,
        title: page.title,
        markdownPath: rel(mdPath),
        screenshots,
      });
    }

    log.success(
      `ingest: ${crawl.pages.length} page(s) via ${crawl.discovery}, ${assets.length} asset(s) downloaded`,
    );
    return { baseUrl: url, pageCap, discovery: crawl.discovery, pages, assets };
  });
}

async function ingestDocs(
  docs: string[],
  ingestDir: string,
  log: Logger,
  rel: (p: string) => string,
): Promise<DocEntry[]> {
  const docsDir = join(ingestDir, "docs");
  const entries: DocEntry[] = [];

  for (const source of docs) {
    if (!existsSync(source)) {
      log.warn(`ingest: document not found: ${source}`);
      entries.push({
        source,
        kind: docKind(source),
        localPath: null,
        chars: 0,
        error: "not found",
      });
      continue;
    }
    try {
      const extracted = await extractDoc(source);
      mkdirSync(docsDir, { recursive: true });
      const outPath = join(docsDir, `${basename(source)}.md`);
      await writeFile(outPath, `${extracted.text}\n`);
      entries.push({
        source,
        kind: extracted.kind,
        localPath: rel(outPath),
        chars: extracted.text.length,
      });
      log.step(
        `ingest: extracted ${extracted.kind} ${basename(source)} (${extracted.text.length} chars)`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`ingest: failed to extract ${source}: ${message}`);
      entries.push({ source, kind: docKind(source), localPath: null, chars: 0, error: message });
    }
  }
  return entries;
}

async function ingestImages(
  images: string[],
  ingestDir: string,
  log: Logger,
  rel: (p: string) => string,
): Promise<ImageEntry[]> {
  const imagesDir = join(ingestDir, "images");
  const entries: ImageEntry[] = [];

  for (const source of images) {
    if (!existsSync(source)) {
      log.warn(`ingest: image not found: ${source}`);
      entries.push({ source, localPath: null, error: "not found" });
      continue;
    }
    mkdirSync(imagesDir, { recursive: true });
    const outPath = join(imagesDir, basename(source));
    await copyFile(source, outPath);
    entries.push({ source, localPath: rel(outPath) });
    log.step(`ingest: copied image ${basename(source)}`);
  }
  return entries;
}
