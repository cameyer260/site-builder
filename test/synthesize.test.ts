import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { type Config, DEFAULTS } from "../src/config/schema.ts";
import type { IngestManifest } from "../src/ingest/manifest.ts";
import { newClient } from "../src/storage/client.ts";
import { clientPaths } from "../src/storage/layout.ts";
import {
  type AssetCandidate,
  type AssetClassification,
  candidateAssets,
  canonicalStem,
  dedupeCandidates,
  looksLikeDerivativeSuffix,
  parseClassification,
  parseSizeSuffix,
  reconcileAssets,
} from "../src/synthesize/assets.ts";
import { CHECKLIST, renderChecklistForPrompt } from "../src/synthesize/checklist.ts";
import {
  displayFieldValue,
  type Profile,
  ProfileSchema,
  statusCounts,
} from "../src/synthesize/profile.ts";
import {
  renderAssetsSection,
  renderChecklistGaps,
  runSynthesize,
} from "../src/synthesize/synthesize.ts";
import { createLogger } from "../src/util/log.ts";
import { fakeStageEngine } from "./fixtures/fake-stage-engine.ts";

// A 1x1 PNG standing in for a downloaded image Asset.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
);
// Same image, padded past dedupeCandidates' MIN_RASTER_BYTES floor — anything
// that flows through runSynthesize's classification path (which now dedupes
// first) needs to clear that floor to reach classification at all; direct
// reconcileAssets tests bypass dedupeCandidates and can keep using bare PNG.
const LARGE_PNG = Buffer.concat([PNG, Buffer.alloc(2000)]);

const log = createLogger({ quiet: true });
const config = { ...DEFAULTS, root: "/unused" } as Config;

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sb-synth-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function emptyManifest(over: Partial<IngestManifest> = {}): IngestManifest {
  return {
    createdAt: new Date().toISOString(),
    inputs: { docCount: 0, imageCount: 0, hasNotes: true },
    docs: [],
    images: [],
    ...over,
  };
}

// ---- Checklist (pure) -----------------------------------------------------

test("the shipped Checklist covers identity, offering, voice and contact", () => {
  const keys = CHECKLIST.map((i) => i.key);
  for (const required of ["companyName", "services", "tone", "contactEmail", "socials"]) {
    expect(keys).toContain(required);
  }
  expect(new Set(keys).size).toBe(keys.length); // keys are unique
  const rendered = renderChecklistForPrompt();
  expect(rendered).toContain("`companyName`");
  expect(rendered).toContain("`callToAction`");
});

// ---- Profile helpers (pure) ----------------------------------------------

test("statusCounts tallies Field statuses", () => {
  const counts = statusCounts([
    { key: "a", label: "A", value: "x", status: "Known" },
    { key: "b", label: "B", value: null, status: "Unknown" },
    { key: "c", label: "C", value: "y", status: "Guessed" },
    { key: "d", label: "D", value: "z", status: "Known" },
  ]);
  expect(counts).toEqual({ Known: 2, Guessed: 1, Unknown: 1 });
});

test("renderChecklistGaps lists Unknown and Guessed fields, not Known ones", () => {
  const profile: Profile = ProfileSchema.parse({
    client: "Acme",
    fields: [
      { key: "companyName", label: "Company name", value: "Acme", status: "Known" },
      { key: "hours", label: "Business hours", value: null, status: "Unknown" },
      { key: "tone", label: "Brand voice", value: "warm", status: "Guessed", note: "inferred" },
    ],
  });
  const md = renderChecklistGaps(profile);
  expect(md).toContain("Business hours");
  expect(md).toContain("Brand voice");
  expect(md).toContain("inferred");
  expect(md).not.toContain("Company name");
});

test("the Profile schema normalizes multi-valued model output to string | string[]", () => {
  // Real models return lists for services/socials and objects for grouped data.
  const profile = ProfileSchema.parse({
    client: "Acme",
    fields: [
      { key: "services", label: "Services", value: ["drains", "heaters"], status: "Known" },
      {
        key: "socials",
        label: "Socials",
        value: { instagram: "https://ig/acme" },
        status: "Known",
      },
      { key: "name", label: "Name", value: "Acme", status: "Known" },
      { key: "hours", label: "Hours", value: null, status: "Unknown" },
    ],
  });
  expect(profile.fields[0]?.value).toEqual(["drains", "heaters"]);
  expect(profile.fields[1]?.value).toEqual(["instagram: https://ig/acme"]); // object → "k: v"
  expect(profile.fields[2]?.value).toBe("Acme");
  expect(profile.fields[3]?.value).toBeNull();

  expect(displayFieldValue(["drains", "heaters"])).toBe("drains, heaters");
  expect(displayFieldValue("Acme")).toBe("Acme");
  expect(displayFieldValue(null)).toBe("");
});

test("renderAssetsSection lists each Asset, flagging fallbacks", () => {
  const section = renderAssetsSection([
    { role: "logo", file: "assets/logo.svg", source: "fallback", description: "Acme logo" },
    { role: "hero", file: "assets/hero.png", source: "captured", description: "Storefront" },
  ]);
  expect(section).toContain("## Assets");
  expect(section).toContain(
    "**logo** (fallback — no original found): `assets/logo.svg` — Acme logo",
  );
  expect(section).toContain("**hero**: `assets/hero.png` — Storefront");
});

test("renderChecklistGaps reports a clean bill when all Known", () => {
  const profile: Profile = ProfileSchema.parse({
    client: "Acme",
    fields: [{ key: "companyName", label: "Company name", value: "Acme", status: "Known" }],
  });
  expect(renderChecklistGaps(profile)).toContain("Every Checklist item is Known");
});

// ---- Asset candidate selection + classification parsing (pure) ------------

test("candidateAssets includes images, skips non-images, and dedupes", () => {
  const manifest = emptyManifest({
    site: {
      baseUrl: "http://x",
      pageCap: 10,
      discovery: "single",
      pages: [],
      assets: [
        {
          url: "http://x/a.png",
          localPath: "site/assets/a.png",
          kind: "img",
          fromPage: "http://x",
          bytes: 1,
        },
        {
          url: "http://x/a.png",
          localPath: "site/assets/a.png",
          kind: "og",
          fromPage: "http://x",
          bytes: 1,
        },
        {
          url: "http://x/styles.css",
          localPath: "site/assets/styles.css",
          kind: "img",
          fromPage: "http://x",
          bytes: 1,
        },
      ],
    },
    images: [{ source: "/tmp/logo.svg", localPath: "images/logo.svg" }],
  });
  const candidates = candidateAssets(manifest, "/ingest");
  const paths = candidates.map((c) => c.absPath);
  expect(paths).toContain(join("/ingest", "site/assets/a.png"));
  expect(paths).toContain(join("/ingest", "images/logo.svg"));
  expect(paths).not.toContain(join("/ingest", "site/assets/styles.css")); // not an image
  expect(paths.filter((p) => p.endsWith("a.png")).length).toBe(1); // deduped
});

test("parseClassification rejects malformed payloads", () => {
  expect(
    parseClassification({ assets: [{ source: "/x", role: "logo", keep: true }] }),
  ).not.toBeNull();
  expect(
    parseClassification({ assets: [{ source: "/x", role: "spaceship", keep: true }] }),
  ).toBeNull();
  expect(parseClassification({ nope: true })).toBeNull();
});

// ---- Candidate de-duplication (ADR-0016, pure) -----------------------------

test("canonicalStem strips each WordPress/retina derivative suffix", () => {
  expect(canonicalStem("photo-150x150")).toBe("photo");
  expect(canonicalStem("photo-768x512")).toBe("photo");
  expect(canonicalStem("photo-scaled")).toBe("photo");
  expect(canonicalStem("photo-rotated")).toBe("photo");
  expect(canonicalStem("photo-e1234567890123")).toBe("photo"); // 13-digit edit timestamp
  expect(canonicalStem("photo@2x")).toBe("photo");
  expect(canonicalStem("photo-2x")).toBe("photo");
  expect(canonicalStem("photo-scaled-300x300")).toBe("photo"); // strips repeatedly
});

test("canonicalStem does not strip the upload-counter suffix", () => {
  // -1/-2/... marks a distinct upload whose name collided (WordPress, and our
  // own uniqueName in src/util/names.ts) — collapsing it would merge unrelated images.
  expect(canonicalStem("photo-1")).toBe("photo-1");
  expect(canonicalStem("AdobeStock_383075787_30-1")).toBe("AdobeStock_383075787_30-1");
});

test("parseSizeSuffix extracts trailing WxH dimensions", () => {
  expect(parseSizeSuffix("photo-150x150")).toEqual({ w: 150, h: 150 });
  expect(parseSizeSuffix("photo-1-768x519")).toEqual({ w: 768, h: 519 });
  expect(parseSizeSuffix("photo")).toBeNull();
});

test("looksLikeDerivativeSuffix recognizes size/crop tokens, dimensions, and cache-bust hashes", () => {
  expect(looksLikeDerivativeSuffix("thegem-gallery-fullwidth")).toBe(true);
  expect(looksLikeDerivativeSuffix("768x512")).toBe(true);
  expect(looksLikeDerivativeSuffix("qicxenrkktrdap0uc1o4yh8ufz5n32g7c3yc411p28")).toBe(true); // 40+ char hash
  expect(looksLikeDerivativeSuffix("left")).toBe(false);
  expect(looksLikeDerivativeSuffix("2")).toBe(false);
  expect(looksLikeDerivativeSuffix("final")).toBe(false);
});

/**
 * Mirrors dedupeCandidates' identity-grouping decision (canonicalStem +
 * bare-original-prefix fold) directly, with no disk I/O and no byte sizes —
 * the "same original?" call is a pure function of the two filenames.
 */
function sameIdentity(nameA: string, nameB: string): boolean {
  const stem = (name: string): string => {
    const ext = extname(name);
    return ext ? name.slice(0, -ext.length) : name;
  };
  const canonA = canonicalStem(stem(nameA));
  const canonB = canonicalStem(stem(nameB));
  if (canonA === canonB) {
    return true;
  }
  const [shorter, longer] = canonA.length <= canonB.length ? [canonA, canonB] : [canonB, canonA];
  return (
    longer.startsWith(`${shorter}-`) && looksLikeDerivativeSuffix(longer.slice(shorter.length + 1))
  );
}

test("real WordPress derivative filenames collapse to their bare original", () => {
  // Group A: TheGem theme crops, bare original present
  expect(
    sameIdentity(
      "13238983_1691353297780257_7245029022018360837_n.jpg",
      "13238983_1691353297780257_7245029022018360837_n-thegem-gallery-fullwidth.jpg",
    ),
  ).toBe(true);
  expect(
    sameIdentity(
      "13238983_1691353297780257_7245029022018360837_n.jpg",
      "13238983_1691353297780257_7245029022018360837_n-thegem-post-thumb-small.jpg",
    ),
  ).toBe(true);

  // Group B: WP core resize sizes, bare original present
  expect(sameIdentity("AdobeStock_899096827_35.jpeg", "AdobeStock_899096827_35-400x400.jpeg")).toBe(
    true,
  );
  expect(sameIdentity("AdobeStock_899096827_35.jpeg", "AdobeStock_899096827_35-600x600.jpeg")).toBe(
    true,
  );
  expect(sameIdentity("AdobeStock_899096827_35.jpeg", "AdobeStock_899096827_35-768x430.jpeg")).toBe(
    true,
  );

  // Group C: favicon size variant
  expect(sameIdentity("PPR-Favicon.png", "PPR-Favicon-150x150.png")).toBe(true);

  // Group D: cache-bust hash suffix, bare original present
  expect(
    sameIdentity(
      "Pioneer-Logo.webp",
      "Pioneer-Logo-qicxenrkktrdap0uc1o4yh8ufz5n32g7c3yc411p28.webp",
    ),
  ).toBe(true);
});

test("content words and distinct uploads are NOT folded together", () => {
  // "left" is a content word, not a derivative token — must stay separate.
  expect(sameIdentity("hero.jpg", "hero-left.jpg")).toBe(false);
  // The "-1" upload counter marks a distinct upload (the same convention our
  // own uniqueName appends on a stem collision). After WxH-stripping, the
  // canons differ (AdobeStock_383075787_30-1 vs AdobeStock_383075787_30), so
  // this correctly stays separate rather than folding a different upload into
  // the -600x600 original's group.
  expect(
    sameIdentity("AdobeStock_383075787_30-1-768x519.jpeg", "AdobeStock_383075787_30-600x600.jpeg"),
  ).toBe(false);
});

// ---- dedupeCandidates integration (fs) -------------------------------------

test("dedupeCandidates collapses byte-identical files, keeps the largest per identity group, and drops undersized rasters", () => {
  const ingest = join(root, "ingest");
  mkdirSync(ingest, { recursive: true });

  // Identity group "hero": the bare original outweighs its WP-sized derivative.
  const heroPath = join(ingest, "hero.png");
  const heroSmallPath = join(ingest, "hero-300x300.png");
  writeFileSync(heroPath, Buffer.alloc(2000, 1));
  writeFileSync(heroSmallPath, Buffer.alloc(1800, 2));

  // Byte-identical pair under unrelated names -> hash dedup keeps the shorter name.
  const identicalShort = join(ingest, "identical.png");
  const identicalLong = join(ingest, "identical-longer-name.png");
  const identicalBytes = Buffer.alloc(1600, 5);
  writeFileSync(identicalShort, identicalBytes);
  writeFileSync(identicalLong, identicalBytes);

  // A tracking-pixel-sized raster, unrelated to any other identity.
  const tinyPath = join(ingest, "tiny.png");
  writeFileSync(tinyPath, PNG); // 69 bytes, well under MIN_RASTER_BYTES

  // A candidate whose file is missing — kept untouched, never dropped for an IO error.
  const missingPath = join(ingest, "missing.png");

  const candidates: AssetCandidate[] = [
    { absPath: heroPath },
    { absPath: heroSmallPath },
    { absPath: identicalShort },
    { absPath: identicalLong },
    { absPath: tinyPath },
    { absPath: missingPath },
  ];

  const result = dedupeCandidates(candidates);
  const paths = result.map((c) => c.absPath);

  expect(paths).toContain(heroPath);
  expect(paths).not.toContain(heroSmallPath); // smaller derivative of the same identity dropped
  expect(paths).toContain(identicalShort);
  expect(paths).not.toContain(identicalLong); // byte-identical, longer name dropped
  expect(paths).not.toContain(tinyPath); // below the raster size floor
  expect(paths).toContain(missingPath); // unreadable -> kept, not dropped
  expect(result.length).toBe(3);
});

test("dedupeCandidates derives identity from the on-disk basename, not the source URL's query string", () => {
  const ingest = join(root, "ingest");
  mkdirSync(ingest, { recursive: true });

  // Byte-DIFFERENT files so the collapse below is proven by filename-grouping,
  // not by the byte-hash step. Their on-disk names are the bare original and a
  // WP-sized derivative, but their `url`s carry cache-bust/resize query strings
  // that would corrupt `basename(candidate.url)` into e.g. "photo.jpg?ver=6.1"
  // pre-fix, defeating extname/stemOf/canonicalStem and keeping both.
  const photoPath = join(ingest, "photo.jpg");
  const photoSmallPath = join(ingest, "photo-150x150.jpg");
  writeFileSync(photoPath, Buffer.concat([LARGE_PNG, Buffer.alloc(10, 9)]));
  writeFileSync(photoSmallPath, Buffer.concat([LARGE_PNG, Buffer.alloc(10, 7)]));

  const candidates: AssetCandidate[] = [
    { absPath: photoPath, url: "https://x.com/photo.jpg?ver=6.1" },
    { absPath: photoSmallPath, url: "https://x.com/photo-150x150.jpg?resize=768,512" },
  ];

  const result = dedupeCandidates(candidates);
  const paths = result.map((c) => c.absPath);

  expect(result.length).toBe(1);
  expect(paths).toContain(photoPath);
  expect(paths).not.toContain(photoSmallPath);
});

// ---- Asset reconciliation (fs) -------------------------------------------

test("reconcileAssets copies kept captured assets and skips a fallback when a logo exists", () => {
  const ingest = join(root, "ingest");
  const contextDir = join(root, "context");
  mkdirSync(join(ingest, "a"), { recursive: true });
  const logoPath = join(ingest, "a", "logo.png");
  const heroPath = join(ingest, "a", "hero.png");
  writeFileSync(logoPath, PNG);
  writeFileSync(heroPath, PNG);

  const classification: AssetClassification = {
    assets: [
      { source: logoPath, role: "logo", keep: true, description: "Acme logo" },
      { source: heroPath, role: "hero", keep: true },
      { source: join(ingest, "a", "missing.png"), role: "photo", keep: true },
    ],
  };
  const manifest = reconcileAssets({
    classification,
    candidates: [{ absPath: logoPath, url: "http://x/logo.png" }, { absPath: heroPath }],
    contextDir,
    clientName: "Acme",
    log,
  });

  expect(manifest.find((a) => a.role === "logo")?.source).toBe("captured");
  expect(manifest.find((a) => a.role === "logo")?.file).toBe("assets/logo.png");
  expect(manifest.find((a) => a.role === "hero")?.file).toBe("assets/hero.png");
  expect(manifest.some((a) => a.source === "fallback")).toBe(false); // a real logo was kept
  expect(existsSync(join(contextDir, "assets", "logo.png"))).toBe(true);
  expect(existsSync(join(contextDir, "assets", "hero.png"))).toBe(true);
});

test("reconcileAssets keeps only the first of a singleton role and drops the rest", () => {
  const ingest = join(root, "ingest");
  const contextDir = join(root, "context");
  mkdirSync(join(ingest, "a"), { recursive: true });
  const logoPath = join(ingest, "a", "logo.png");
  const logo2Path = join(ingest, "a", "logo2.png");
  writeFileSync(logoPath, PNG);
  writeFileSync(logo2Path, PNG);

  const classification: AssetClassification = {
    assets: [
      { source: logoPath, role: "logo", keep: true, description: "Acme logo" },
      { source: logo2Path, role: "logo", keep: true, description: "Acme logo variant" },
    ],
  };
  const manifest = reconcileAssets({
    classification,
    candidates: [{ absPath: logoPath }, { absPath: logo2Path }],
    contextDir,
    clientName: "Acme",
    log,
  });

  expect(manifest.filter((a) => a.role === "logo")).toHaveLength(1);
  expect(manifest.find((a) => a.role === "logo")?.file).toBe("assets/logo.png");
  expect(existsSync(join(contextDir, "assets", "logo2.png"))).toBe(false);
});

test("reconcileAssets drops a multi-instance-role asset with no description, keeps a described one", () => {
  const ingest = join(root, "ingest");
  const contextDir = join(root, "context");
  mkdirSync(join(ingest, "a"), { recursive: true });
  const teamPath = join(ingest, "a", "team.png");
  const team2Path = join(ingest, "a", "team2.png");
  writeFileSync(teamPath, PNG);
  writeFileSync(team2Path, PNG);

  const classification: AssetClassification = {
    assets: [
      { source: teamPath, role: "team", keep: true },
      { source: team2Path, role: "team", keep: true, description: "Two staff at the counter" },
    ],
  };
  const manifest = reconcileAssets({
    classification,
    candidates: [{ absPath: teamPath }, { absPath: team2Path }],
    contextDir,
    clientName: "Acme",
    log,
  });

  expect(manifest.filter((a) => a.role === "team")).toHaveLength(1);
  expect(manifest.find((a) => a.role === "team")?.file).toBe("assets/team.png");
  expect(existsSync(join(contextDir, "assets", "team.png"))).toBe(true);
});

test("reconcileAssets drops in the Fallback Asset logo when none is captured", () => {
  const contextDir = join(root, "context");
  const manifest = reconcileAssets({
    classification: { assets: [] },
    candidates: [],
    contextDir,
    clientName: "Acme",
    log,
  });
  const logo = manifest.find((a) => a.role === "logo");
  expect(logo?.source).toBe("fallback");
  expect(logo?.file).toBe("assets/logo.svg");
  expect(existsSync(join(contextDir, "assets", "logo.svg"))).toBe(true);
});

// ---- runSynthesize end-to-end (fake engine) -------------------------------

test("runSynthesize emits a Profile + Checklist gaps and a fallback logo (notes-only)", async () => {
  const paths = clientPaths(root, "Acme Plumbing");
  mkdirSync(paths.ingest, { recursive: true });
  const client = newClient("Acme Plumbing", { docs: [], images: [], notes: "family-owned" });

  const profile = await runSynthesize({
    paths,
    config,
    client,
    manifest: emptyManifest({ notes: "notes.md" }),
    log,
    engine: fakeStageEngine(),
  });

  // milestone artifacts present
  expect(existsSync(join(paths.context, "profile.json"))).toBe(true);
  expect(existsSync(join(paths.context, "profile.md"))).toBe(true);
  expect(existsSync(join(paths.context, "checklist.md"))).toBe(true);

  // client name is authoritative (overrides whatever the model wrote)
  expect(profile.client).toBe("Acme Plumbing");
  // Known and Unknown fields both present — the milestone
  const counts = statusCounts(profile.fields);
  expect(counts.Known).toBeGreaterThan(0);
  expect(counts.Unknown).toBeGreaterThan(0);

  // no captured assets -> fallback logo
  expect(profile.assets.find((a) => a.role === "logo")?.source).toBe("fallback");
  expect(existsSync(join(paths.context, "assets", "logo.svg"))).toBe(true);

  // checklist gaps were derived from the statuses
  expect(readFileSync(join(paths.context, "checklist.md"), "utf8")).toContain("Business hours");
});

test("runSynthesize classifies captured assets into the manifest (vision call)", async () => {
  const paths = clientPaths(root, "Acme Plumbing");
  const logoAbs = join(paths.ingest, "site/assets/logo.png");
  mkdirSync(join(paths.ingest, "site/assets"), { recursive: true });
  writeFileSync(logoAbs, LARGE_PNG);
  const client = newClient("Acme Plumbing", { docs: [], images: [], notes: "n" });

  const manifest = emptyManifest({
    site: {
      baseUrl: "http://x",
      pageCap: 10,
      discovery: "single",
      pages: [],
      assets: [
        {
          url: "http://x/logo.png",
          localPath: "site/assets/logo.png",
          kind: "img",
          fromPage: "http://x",
          bytes: LARGE_PNG.length,
        },
      ],
    },
  });

  const profile = await runSynthesize({
    paths,
    config,
    client,
    manifest,
    log,
    engine: fakeStageEngine({
      assetsJson: {
        assets: [{ source: logoAbs, role: "logo", keep: true, description: "Acme logo" }],
      },
    }),
  });

  const logo = profile.assets.find((a) => a.role === "logo");
  expect(logo?.source).toBe("captured");
  expect(logo?.file).toBe("assets/logo.png");
  expect(logo?.originalUrl).toBe("http://x/logo.png");
  expect(existsSync(join(paths.context, "assets", "logo.png"))).toBe(true);

  // profile.md (written before the asset manifest exists) gets the Assets
  // section appended, so `generate`'s primary human-readable doc actually
  // surfaces what it should reuse instead of only raw JSON.
  const profileMd = readFileSync(join(paths.context, "profile.md"), "utf8");
  expect(profileMd).toContain("## Assets");
  expect(profileMd).toContain("**logo**: `assets/logo.png` — Acme logo");
});

test("runSynthesize trusts a valid assets.json even when the classification call reports a non-ok result", async () => {
  const paths = clientPaths(root, "Acme Plumbing");
  const logoAbs = join(paths.ingest, "site/assets/logo.png");
  mkdirSync(join(paths.ingest, "site/assets"), { recursive: true });
  writeFileSync(logoAbs, LARGE_PNG);
  const client = newClient("Acme Plumbing", { docs: [], images: [], notes: "n" });

  const manifest = emptyManifest({
    site: {
      baseUrl: "http://x",
      pageCap: 10,
      discovery: "single",
      pages: [],
      assets: [
        {
          url: "http://x/logo.png",
          localPath: "site/assets/logo.png",
          kind: "img",
          fromPage: "http://x",
          bytes: LARGE_PNG.length,
        },
      ],
    },
  });

  const profile = await runSynthesize({
    paths,
    config,
    client,
    manifest,
    log,
    engine: fakeStageEngine({
      assetsJson: {
        assets: [{ source: logoAbs, role: "logo", keep: true, description: "Acme logo" }],
      },
      failClassification: true,
    }),
  });

  // the captured logo is used despite the engine reporting failure — not the fallback
  const logo = profile.assets.find((a) => a.role === "logo");
  expect(logo?.source).toBe("captured");
  expect(logo?.file).toBe("assets/logo.png");
  expect(existsSync(join(paths.context, "assets", "logo.png"))).toBe(true);
});

test("runSynthesize keeps the tolerated classification-failure warning short and moves the stderr excerpt to an info trace", async () => {
  const paths = clientPaths(root, "Acme Plumbing");
  const logoAbs = join(paths.ingest, "site/assets/logo.png");
  mkdirSync(join(paths.ingest, "site/assets"), { recursive: true });
  writeFileSync(logoAbs, LARGE_PNG);
  const client = newClient("Acme Plumbing", { docs: [], images: [], notes: "n" });

  const manifest = emptyManifest({
    site: {
      baseUrl: "http://x",
      pageCap: 10,
      discovery: "single",
      pages: [],
      assets: [
        {
          url: "http://x/logo.png",
          localPath: "site/assets/logo.png",
          kind: "img",
          fromPage: "http://x",
          bytes: LARGE_PNG.length,
        },
      ],
    },
  });

  const warns: string[] = [];
  const infos: string[] = [];
  const spyLog = {
    ...log,
    warn: (m: string) => warns.push(m),
    info: (m: string) => infos.push(m),
  };
  const stderrExcerpt = "EPIPE: broken pipe, write\n  fd: 5\n".repeat(20);

  await runSynthesize({
    paths,
    config,
    client,
    manifest,
    log: spyLog,
    engine: fakeStageEngine({
      assetsJson: {
        assets: [{ source: logoAbs, role: "logo", keep: true, description: "Acme logo" }],
      },
      failClassification: true,
      classificationStderrExcerpt: stderrExcerpt,
    }),
  });

  // The console-facing warning stays a one-liner — no raw stderr dump.
  const classificationWarn = warns.find((w) => w.includes("using it anyway"));
  expect(classificationWarn).toBeDefined();
  expect(classificationWarn).not.toContain("EPIPE");
  expect(classificationWarn?.length ?? Infinity).toBeLessThan(200);

  // The full excerpt is still captured, just at info level instead.
  expect(infos.some((i) => i.includes("EPIPE") && i.includes("stderr"))).toBe(true);
});

async function expectSynthesizeError(
  engine: ReturnType<typeof fakeStageEngine>,
  pattern: RegExp,
): Promise<void> {
  const paths = clientPaths(root, "Acme");
  mkdirSync(paths.ingest, { recursive: true });
  const client = newClient("Acme", { docs: [], images: [], notes: "n" });
  let caught: unknown;
  try {
    await runSynthesize({ paths, config, client, manifest: emptyManifest(), log, engine });
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toMatch(pattern);
}

test("runSynthesize fails when the profile call fails", async () => {
  await expectSynthesizeError(fakeStageEngine({ failProfile: true }), /profile synthesis failed/);
});

test("runSynthesize fails when profile.json is not written", async () => {
  await expectSynthesizeError(fakeStageEngine({ skipProfileJson: true }), /profile\.json/);
});

test("runSynthesize fails when profile.json omits Checklist fields", async () => {
  await expectSynthesizeError(
    fakeStageEngine({
      profileJson: {
        client: "Acme",
        fields: [{ key: "companyName", label: "Company name", value: "Acme", status: "Known" }],
      },
    }),
    /does not match Checklist/,
  );
});
