import { z } from "zod";
import type { EngineKind } from "../engine/adapter.ts";

/**
 * Tool-level configuration, stored at `~/.config/site-builder/config.json`
 * (XDG-aware). Distinct from any per-Client data, which lives under the Root.
 *
 * Schema bump (ADR-0010): `engineBin`/`models` replaced by `defaultEngine`/
 * `engines`. Old keys are silently stripped by Zod (strip mode); new keys are
 * defaulted from DEFAULTS so an existing config.json keeps loading unchanged.
 * Re-run `sb config` to persist the new shape.
 */

export const ViewportsSchema = z.object({
  desktop: z.number().int().positive(),
  mobile: z.number().int().positive(),
});
export type Viewports = z.infer<typeof ViewportsSchema>;

/** Per-engine model pair: best tier (generate/audit/synthesize) and small tier (asset classification / Design Brief). */
export const EngineProfileSchema = z.object({
  bin: z.string().min(1),
  models: z.object({
    best: z.string().min(1),
    small: z.string().min(1),
  }),
});
export type EngineProfile = z.infer<typeof EngineProfileSchema>;

export const ConfigSchema = z.object({
  /** The single Root directory under which every Client folder lives. */
  root: z.string().min(1),
  /** Which Engine to use when `--engine` is not passed. Defaults to "claudey". */
  defaultEngine: z.enum(["claudey", "codey", "opencode"]).default("claudey"),
  /** Per-engine reference data: binary path + model pair for each tier. */
  engines: z
    .object({
      claudey: EngineProfileSchema,
      codey: EngineProfileSchema,
      opencode: EngineProfileSchema,
    })
    .default({
      claudey: { bin: "claudey", models: { best: "claude-opus-4-8", small: "claude-sonnet-4-6" } },
      codey: { bin: "codey", models: { best: "gpt-5.5", small: "gpt-5.4-mini" } },
      opencode: {
        bin: "opencode",
        models: {
          best: "openrouter/deepseek/deepseek-v4-pro",
          small: "openrouter/deepseek/deepseek-v4-flash",
        },
      },
    }),
  /** The Cloudflare deploy binary. */
  wranglerBin: z.string().min(1).default("wrangler"),
  /**
   * The GitHub CLI binary, used only by the opt-in `--github`/`sb push` flow
   * (ADR-0004). Defaulted so configs written before Phase 8 still load.
   */
  ghBin: z.string().min(1).default("gh"),
  /** Optional Pexels API key for tier-2 stock imagery during generate. */
  pexelsApiKey: z.string().optional(),
  viewports: ViewportsSchema.default({ desktop: 1440, mobile: 390 }),
  /** Default crawl page cap; overridable per run with `--pages`. */
  pageCap: z.number().int().positive().default(10),
});
export type Config = z.infer<typeof ConfigSchema>;

/** Everything except the user-chosen Root, which has no sensible default. */
export const DEFAULTS: Omit<Config, "root" | "pexelsApiKey"> = {
  defaultEngine: "claudey" as EngineKind,
  engines: {
    claudey: { bin: "claudey", models: { best: "claude-opus-4-8", small: "claude-sonnet-4-6" } },
    codey: { bin: "codey", models: { best: "gpt-5.5", small: "gpt-5.4-mini" } },
    opencode: {
      bin: "opencode",
      models: {
        best: "openrouter/deepseek/deepseek-v4-pro",
        small: "openrouter/deepseek/deepseek-v4-flash",
      },
    },
  },
  wranglerBin: "wrangler",
  ghBin: "gh",
  viewports: { desktop: 1440, mobile: 390 },
  pageCap: 10,
};
