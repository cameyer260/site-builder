import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EngineResult, EngineRunner } from "../../src/engine/runner.ts";

/**
 * In-process fake of `runEngine` for the `generate` stage. It dispatches on the
 * opening line of each prompt — the Design Brief call vs. the Site build call —
 * and writes the on-disk artifacts the real model would (brief files, a tailored
 * `site.ts`, and a declared stock-image slot), so `runGenerate` can be exercised
 * offline and deterministically.
 */

const ok = (): EngineResult => ({
  ok: true,
  resultText: "done",
  isError: false,
  exitCode: 0,
  events: [],
});

const fail = (): EngineResult => ({
  ok: false,
  resultText: null,
  isError: true,
  exitCode: 1,
  events: [],
  error: "forced engine failure",
});

export interface FakeGenerateEngineOptions {
  /** Make the Brief call report failure. */
  failBrief?: boolean;
  /** Brief call succeeds but writes no brief.md (exercises the fallback Brief). */
  skipBriefMd?: boolean;
  /** Make the Site build call report failure. */
  failBuild?: boolean;
  /** Don't write generate/images.json (no stock slots declared). */
  skipImagesJson?: boolean;
  /** Override the images.json payload (default: one landscape hero slot). */
  imagesJson?: unknown;
}

export function fakeGenerateEngine(options: FakeGenerateEngineOptions = {}): EngineRunner {
  return async (_engineBin, opts) => {
    const dir = opts.cwd;

    if (opts.prompt.includes("art director defining the Design Brief")) {
      if (options.failBrief) {
        return fail();
      }
      if (!options.skipBriefMd) {
        writeFileSync(join(dir, "brief.md"), "# Design Brief\n\nWarm, modern, trustworthy.\n");
        writeFileSync(
          join(dir, "brief.json"),
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
        return fail();
      }
      // Stand in for the model tailoring the Kit.
      mkdirSync(join(dir, "src", "data"), { recursive: true });
      writeFileSync(
        join(dir, "src", "data", "site.ts"),
        'export const site = { name: "Tailored Co." } as const;\n',
      );
      if (!options.skipImagesJson) {
        mkdirSync(join(dir, "generate"), { recursive: true });
        writeFileSync(
          join(dir, "generate", "images.json"),
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
