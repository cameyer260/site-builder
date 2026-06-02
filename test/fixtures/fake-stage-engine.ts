import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EngineResult, EngineRunner } from "../../src/engine/runner.ts";
import { CHECKLIST } from "../../src/synthesize/checklist.ts";

/**
 * An in-process fake of `runEngine` for the AI stages: instead of spawning
 * `claude -p`, it writes the on-disk artifacts the real model would, so the
 * pipeline can be exercised offline and deterministically. It dispatches on the
 * target file named in the prompt (synthesize's two calls write `assets.json`
 * and `profile.json`/`profile.md` respectively).
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
