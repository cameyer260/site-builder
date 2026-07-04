import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EngineResult, EngineRunner } from "../../src/engine/runner.ts";
import { ARTIFACTS_DIRNAME } from "../../src/generate/artifacts.ts";
import { CHECKLIST } from "../../src/synthesize/checklist.ts";

/**
 * An in-process fake of `runEngine` for the AI stages: instead of spawning
 * `claude -p`, it writes the on-disk artifacts the real model would, so the
 * pipeline can be exercised offline and deterministically. It dispatches on the
 * prompt — synthesize's two calls write `assets.json` and
 * `profile.json`/`profile.md`; generate's two calls write `brief.md` and a
 * tailored `site.ts` + declared image slot; audit's review writes `audit.md` —
 * covering the full pipeline.
 */

const ok = (): EngineResult => ({
  ok: true,
  resultText: "done",
  isError: false,
  exitCode: 0,
  events: [],
});

export interface FakeStageEngineOptions {
  /** Payload written to `assets.json` for the classification call. */
  assetsJson?: unknown;
  /** Payload written to `profile.json` for the profile call. */
  profileJson?: unknown;
  /** Contents written to `profile.md`. */
  profileMd?: string;
  /** Return a non-ok result for the profile call (simulates an engine failure). */
  failProfile?: boolean;
  /** Don't write `profile.json` (simulates a model that ignored instructions). */
  skipProfileJson?: boolean;
}

const DEFAULT_PROFILE = {
  client: "Test Client",
  fields: CHECKLIST.map((item) => {
    if (item.key === "companyName") {
      return { key: item.key, label: item.label, value: "Test Client", status: "Known" };
    }
    if (item.key === "industry") {
      return { key: item.key, label: item.label, value: "plumbing", status: "Known" };
    }
    if (item.key === "tone") {
      return {
        key: item.key,
        label: item.label,
        value: "warm and dependable",
        status: "Guessed",
        note: "inferred from site copy",
      };
    }
    return { key: item.key, label: item.label, value: null, status: "Unknown" };
  }),
  contact: { email: "hi@test.example" },
};

export function fakeStageEngine(options: FakeStageEngineOptions = {}): EngineRunner {
  return async (_engineBin, opts) => {
    // generate's Design Brief call
    if (opts.prompt.includes("art director defining the Design Brief")) {
      const artifactsDir = join(opts.cwd, ARTIFACTS_DIRNAME);
      mkdirSync(artifactsDir, { recursive: true });
      writeFileSync(join(artifactsDir, "brief.md"), "# Design Brief\n\nClean and modern.\n");
      return ok();
    }
    // generate's Site build call
    if (opts.prompt.includes("building a production-quality marketing website")) {
      mkdirSync(join(opts.cwd, "src", "data"), { recursive: true });
      writeFileSync(join(opts.cwd, "src", "data", "site.ts"), "export const site = {};\n");
      const artifactsDir = join(opts.cwd, ARTIFACTS_DIRNAME);
      mkdirSync(artifactsDir, { recursive: true });
      writeFileSync(
        join(artifactsDir, "images.json"),
        JSON.stringify({ slots: [{ id: "hero", query: "office", orientation: "landscape" }] }),
      );
      return ok();
    }
    // audit's review + fix call
    if (opts.prompt.includes("audit reviewer for a freshly generated")) {
      mkdirSync(join(opts.cwd, "audit"), { recursive: true });
      writeFileSync(join(opts.cwd, "audit", "audit.md"), "# Audit\n\nLooks good.\n");
      return ok();
    }
    if (opts.prompt.includes("assets.json")) {
      writeFileSync(
        join(opts.cwd, "assets.json"),
        JSON.stringify(options.assetsJson ?? { assets: [] }),
      );
      return ok();
    }
    if (opts.prompt.includes("profile.json")) {
      if (options.failProfile) {
        return {
          ok: false,
          resultText: null,
          isError: true,
          exitCode: 1,
          events: [],
          error: "forced profile failure",
        };
      }
      if (!options.skipProfileJson) {
        writeFileSync(
          join(opts.cwd, "profile.json"),
          JSON.stringify(options.profileJson ?? DEFAULT_PROFILE),
        );
      }
      writeFileSync(
        join(opts.cwd, "profile.md"),
        options.profileMd ?? "# Profile\n\nTest Client.\n",
      );
      return ok();
    }
    return ok();
  };
}
