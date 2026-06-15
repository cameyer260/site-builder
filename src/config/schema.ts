import { z } from "zod";

/**
 * Tool-level configuration, stored at `~/.config/site-builder/config.json`
 * (XDG-aware). Distinct from any per-Client data, which lives under the Root.
 */

export const ViewportsSchema = z.object({
  desktop: z.number().int().positive(),
  mobile: z.number().int().positive(),
});
export type Viewports = z.infer<typeof ViewportsSchema>;

/** Per-stage model selection (see ADR-0001). */
export const ModelsSchema = z.object({
  generate: z.string().min(1),
  audit: z.string().min(1),
  synthesize: z.string().min(1),
  assetClassification: z.string().min(1),
});
export type Models = z.infer<typeof ModelsSchema>;

export const ConfigSchema = z.object({
  /** The single Root directory under which every Client folder lives. */
  root: z.string().min(1),
  /** The `claude -p` engine binary; the `claudey` container wrapper by default (ADR-0001). */
  engineBin: z.string().min(1),
  /** The Cloudflare deploy binary. */
  wranglerBin: z.string().min(1),
  /**
   * The GitHub CLI binary, used only by the opt-in `--github`/`sb push` flow
   * (ADR-0004). Defaulted so configs written before Phase 8 still load.
   */
  ghBin: z.string().min(1).default("gh"),
  /** Optional Pexels API key for tier-2 stock imagery during generate. */
  pexelsApiKey: z.string().optional(),
  viewports: ViewportsSchema,
  /** Default crawl page cap; overridable per run with `--pages`. */
  pageCap: z.number().int().positive(),
  models: ModelsSchema,
});
export type Config = z.infer<typeof ConfigSchema>;

/** Everything except the user-chosen Root, which has no sensible default. */
export const DEFAULTS = {
  engineBin: "claudey",
  wranglerBin: "wrangler",
  ghBin: "gh",
  viewports: { desktop: 1440, mobile: 390 },
  pageCap: 10,
  models: {
    generate: "claude-opus-4-8",
    audit: "claude-opus-4-8",
    synthesize: "claude-sonnet-4-6",
    assetClassification: "claude-sonnet-4-6",
  },
} satisfies Omit<Config, "root" | "pexelsApiKey">;
