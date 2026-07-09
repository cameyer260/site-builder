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

/**
 * Per-engine model configuration. Two base intelligence tiers (`best`, `small`)
 * that every capability role falls back to, plus optional per-role overrides
 * (`modelRoles`) that route a call to a specific model regardless of tier —
 * see `engine/tiers.ts`. Multimodal engines (claudey/codey) leave `modelRoles`
 * empty and rely on the tiers; an à-la-carte engine (opencode over OpenRouter)
 * uses the overrides to send text-only calls to cheap text models while keeping
 * the two base tiers on vision models for the calls that inspect images.
 */
export const EngineProfileSchema = z.object({
  bin: z.string().min(1),
  models: z.object({
    best: z.string().min(1),
    small: z.string().min(1),
  }),
  modelRoles: z
    .object({
      /** cheap vision — asset classification + Design Brief */
      classify: z.string().min(1).optional(),
      /** text coder — the Site build */
      code: z.string().min(1).optional(),
      /** smart text — profile synthesis */
      reason: z.string().min(1).optional(),
      /** smart vision — the audit review */
      audit: z.string().min(1).optional(),
    })
    .default({}),
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
      claudey: {
        bin: "claudey",
        models: { best: "claude-opus-4-8", small: "claude-sonnet-5" },
        modelRoles: {},
      },
      codey: {
        bin: "codey",
        models: { best: "gpt-5.5", small: "gpt-5.4-mini" },
        modelRoles: {},
      },
      opencode: {
        bin: "opencode",
        // Base tiers are multimodal so the vision roles work by default: `small`
        // (classify) and `best` (audit). The text-only roles are routed below to
        // cheaper text models — DeepSeek/GLM have no vision, hence the split.
        models: {
          best: "openrouter/google/gemini-3-pro-preview",
          small: "openrouter/google/gemini-3-flash-preview",
        },
        modelRoles: {
          code: "openrouter/z-ai/glm-5.2",
          reason: "openrouter/deepseek/deepseek-v4-pro",
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
    claudey: {
      bin: "claudey",
      models: { best: "claude-opus-4-8", small: "claude-sonnet-5" },
      modelRoles: {},
    },
    codey: {
      bin: "codey",
      models: { best: "gpt-5.5", small: "gpt-5.4-mini" },
      modelRoles: {},
    },
    opencode: {
      bin: "opencode",
      models: {
        best: "openrouter/google/gemini-3-pro-preview",
        small: "openrouter/google/gemini-3-flash-preview",
      },
      modelRoles: {
        code: "openrouter/z-ai/glm-5.2",
        reason: "openrouter/deepseek/deepseek-v4-pro",
      },
    },
  },
  wranglerBin: "wrangler",
  ghBin: "gh",
  viewports: { desktop: 1440, mobile: 390 },
  pageCap: 10,
};
