import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { type Config, DEFAULTS } from "../src/config/schema.ts";
import { runIngest } from "../src/ingest/ingest.ts";
import { readManifest } from "../src/ingest/manifest.ts";
import { ClientInputsSchema } from "../src/storage/client.ts";
import { clientPaths } from "../src/storage/layout.ts";
import { createLogger } from "../src/util/log.ts";

// A 1x1 PNG, used for every image route in the fixture site.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
);

const PAGE = (title: string, body: string) =>
  `<!doctype html><html><head><title>${title}</title>` +
  `<meta property="og:image" content="/og.png">` +
  `<link rel="icon" href="/favicon.ico"></head><body>${body}</body></html>`;

let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const { pathname, origin } = new URL(req.url);
      switch (pathname) {
        case "/":
          return html(
            PAGE(
              "Acme Home",
              `<h1>Acme Plumbing</h1><img src="/logo.png" alt="logo">` +
                `<nav><a href="/about">About</a> <a href="/services">Services</a></nav>`,
            ),
          );
        case "/about":
          return html(PAGE("About Acme", "<h1>About</h1><p>Since 1998.</p>"));
        case "/services":
          return html(PAGE("Acme Services", "<h1>Services</h1><p>Drains and pipes.</p>"));
        case "/sitemap.xml":
          return new Response(
            `<?xml version="1.0"?><urlset><url><loc>${origin}/</loc></url>` +
              `<url><loc>${origin}/about</loc></url><url><loc>${origin}/services</loc></url></urlset>`,
            { headers: { "content-type": "application/xml" } },
          );
        case "/logo.png":
        case "/og.png":
          return new Response(PNG, { headers: { "content-type": "image/png" } });
        case "/favicon.ico":
          return new Response(PNG, { headers: { "content-type": "image/x-icon" } });
        default:
          return new Response("not found", { status: 404 });
      }
    },
  });
  base = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

function html(markup: string): Response {
  return new Response(markup, { headers: { "content-type": "text/html" } });
}

function ctxFor(root: string, name: string) {
  return {
    paths: clientPaths(root, name),
    config: { ...DEFAULTS, root } as Config,
    log: createLogger({ quiet: true }),
  };
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sb-ingest-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// Browser-dependent: skip cleanly where chromium isn't installed.
const browserAvailable = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

test.skipIf(!browserAvailable)(
  "crawls a site via sitemap, downloads assets, captures screenshots",
  async () => {
    const { paths, config, log } = ctxFor(root, "Acme");
    const inputs = ClientInputsSchema.parse({ url: base });

    const manifest = await runIngest({ paths, inputs, config, pageCap: 10, log });

    expect(manifest.site?.discovery).toBe("sitemap");
    expect(manifest.site?.pages.length).toBe(3);

    // each page's markdown file exists under ingest/
    for (const page of manifest.site?.pages ?? []) {
      expect(existsSync(join(paths.ingest, page.markdownPath))).toBe(true);
      // screenshots captured for both profiles
      expect((page.screenshots.desktop ?? []).length).toBeGreaterThanOrEqual(1);
      expect((page.screenshots.mobile ?? []).length).toBeGreaterThanOrEqual(1);
      expect(existsSync(join(paths.ingest, page.screenshots.desktop?.[0] as string))).toBe(true);
    }

    // assets downloaded (logo + og + favicon) with files on disk
    expect(manifest.site?.assets.length ?? 0).toBeGreaterThanOrEqual(2);
    for (const asset of manifest.site?.assets ?? []) {
      expect(existsSync(join(paths.ingest, asset.localPath))).toBe(true);
    }

    // manifest is valid on re-read
    expect(readManifest(join(paths.ingest, "manifest.json"))?.site?.pages.length).toBe(3);
  },
  60_000,
);

test("ingests docs, image, and notes without a URL (no browser)", async () => {
  const { paths, config, log } = ctxFor(root, "DocsOnly");
  const fixtures = join(import.meta.dir, "fixtures");
  const txt = join(root, "note.txt");
  writeFileSync(txt, "plumbing since 1998");
  const img = join(root, "logo.png");
  writeFileSync(img, PNG);

  const inputs = ClientInputsSchema.parse({
    docs: [txt, join(fixtures, "sample.pdf"), join(fixtures, "sample.docx")],
    images: [img],
    notes: "family-owned, 24/7 emergency service",
  });

  const manifest = await runIngest({ paths, inputs, config, pageCap: 10, log });

  expect(manifest.site).toBeUndefined();
  expect(manifest.docs.length).toBe(3);
  for (const doc of manifest.docs) {
    expect(doc.localPath).not.toBeNull();
    expect(doc.chars).toBeGreaterThan(0);
    expect(existsSync(join(paths.ingest, doc.localPath as string))).toBe(true);
  }
  // the PDF doc round-trips its text through extraction
  const pdfDoc = manifest.docs.find((d) => d.kind === "pdf");
  expect(pdfDoc).toBeDefined();
  expect(Bun.file(join(paths.ingest, pdfDoc?.localPath as string)).text()).resolves.toContain(
    "Acme Plumbing",
  );

  expect(manifest.images.length).toBe(1);
  expect(manifest.notes).toBeDefined();
  expect(existsSync(join(paths.ingest, "notes.md"))).toBe(true);
});
