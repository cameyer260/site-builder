import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { EngineResult, EngineRunner } from "../../src/engine/runner.ts";
import { ARTIFACTS_DIRNAME } from "../../src/generate/artifacts.ts";

/**
 * In-process fake of `runEngine` for the `generate` stage. It dispatches on the
 * opening line of each prompt — the Design Brief call vs. the Site build call —
 * and writes the on-disk artifacts the real model would (brief files, a tailored
 * `site.ts`, and a declared stock-image slot), so `runGenerate` can be exercised
 * offline and deterministically.
 */

/** Stand-in bytes for a captured Asset, shared with tests seeding the source file at the same content. */
export const FAKE_ASSET_BYTES = "captured-asset-bytes";

const ok = (): EngineResult => ({
  ok: true,
  resultText: "done",
  isError: false,
  exitCode: 0,
  events: [],
});

const fail = (stderrExcerpt?: string): EngineResult => ({
  ok: false,
  resultText: null,
  isError: true,
  exitCode: 1,
  events: [],
  error: "forced engine failure",
  stderrExcerpt,
});

export interface FakeGenerateEngineOptions {
  /** Make the Brief call report failure. */
  failBrief?: boolean;
  /** Brief call succeeds but writes no brief.md (exercises the fallback Brief). */
  skipBriefMd?: boolean;
  /** Make the Site build call report failure. */
  failBuild?: boolean;
  /** `stderrExcerpt` attached to a forced build failure — a cause the engine printed only there. */
  buildStderrExcerpt?: string;
  /** Don't write .site-builder/images.json (no stock slots declared). */
  skipImagesJson?: boolean;
  /** Override the images.json payload (default: one landscape hero slot). */
  imagesJson?: unknown;
  /**
   * The `assets/<file>` (`profile.json` shape) of an already-staged Asset to
   * reference from `src/data/site.ts`, simulating the model wiring in a
   * captured Asset `placeCapturedAssets` staged before this call ran.
   */
  referenceAsset?: string;
}

export function fakeGenerateEngine(options: FakeGenerateEngineOptions = {}): EngineRunner {
  return async (_engineBin, opts) => {
    const dir = opts.cwd;

    if (opts.prompt.includes("art director defining the Design Brief")) {
      if (options.failBrief) {
        return fail();
      }
      if (!options.skipBriefMd) {
        const artifactsDir = join(dir, ARTIFACTS_DIRNAME);
        mkdirSync(artifactsDir, { recursive: true });
        writeFileSync(
          join(artifactsDir, "brief.md"),
          "# Design Brief\n\nWarm, modern, trustworthy.\n",
        );
        writeFileSync(
          join(artifactsDir, "brief.json"),
          JSON.stringify({
            palette: { brand: "#1d4ed8", accent: "#f59e0b", ink: "#0f172a", surface: "#ffffff" },
            fonts: { heading: "Sora", body: "Inter" },
            style: "clean",
            mood: "trustworthy",
            imagery: "authentic local photography",
          }),
        );
      }
      return ok();
    }

    if (opts.prompt.includes("building a production-quality marketing website")) {
      if (options.failBuild) {
        return fail(options.buildStderrExcerpt);
      }
      // Stand in for the model tailoring the Kit.
      mkdirSync(join(dir, "src", "data"), { recursive: true });
      const assetImport = options.referenceAsset
        ? `import "@/assets/captured/${basename(options.referenceAsset)}";\n`
        : "";
      writeFileSync(
        join(dir, "src", "data", "site.ts"),
        `${assetImport}export const site = { name: "Tailored Co." } as const;\n`,
      );
      if (!options.skipImagesJson) {
        const artifactsDir = join(dir, ARTIFACTS_DIRNAME);
        mkdirSync(artifactsDir, { recursive: true });
        writeFileSync(
          join(artifactsDir, "images.json"),
          JSON.stringify(
            options.imagesJson ?? {
              slots: [
                {
                  id: "hero",
                  query: "modern local business",
                  orientation: "landscape",
                  alt: "hero",
                },
              ],
            },
          ),
        );
      }
      return ok();
    }

    return ok();
  };
}
