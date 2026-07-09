import type { EngineProfile } from "../config/schema.ts";

/**
 * Capability-role model routing (ADR-0013, revising ADR-0010's small/best axis).
 * Each pipeline engine call is classified by what it actually needs — modality
 * (does it open images?) and intelligence (cheap extraction vs. deep judgment) —
 * instead of a single small/best tier. Multimodal engines (claudey/codey)
 * collapse the roles onto their two base tiers, since vision is free for every
 * one of their models; an à-la-carte engine (opencode over OpenRouter) overrides
 * per role to send the text-only calls to cheap text models and reserve
 * multimodal spend for the calls that genuinely look at pixels. The mapping is
 * in code, not config, so it cannot drift.
 */

/** The capability roles every model-consuming call maps to. */
export const ROLES = ["classify", "code", "reason", "audit"] as const;
export type Role = (typeof ROLES)[number];

/**
 * Stage / sub-call → capability role:
 * - `classify` (cheap **vision**): asset classification and the Design Brief
 *   both open captured images (the logo, existing-site screenshots), so both
 *   need a multimodal model — the Brief is *not* a text-only call.
 * - `code` (**text**): the Site build works from the text Brief/Profile plus
 *   asset paths + alt text; it never opens an image, so a strong, cheap text
 *   coder is enough (and it's the highest-volume call — where cheap matters most).
 * - `reason` (**text**): profile synthesis is deep text research over the crawl.
 * - `audit` (smart **vision**): the review inspects screenshots for visual quality.
 */
export const STAGE_ROLE: Record<string, Role> = {
  assetClassification: "classify",
  brief: "classify",
  generate: "code",
  synthesize: "reason",
  audit: "audit",
};

/**
 * The base intelligence tier each role falls back to when an engine sets no
 * per-role model. Multimodal engines rely entirely on this collapse: the cheap
 * role → the `small` model, the judgment roles → the `best` model.
 */
export const ROLE_TIER: Record<Role, "small" | "best"> = {
  classify: "small",
  code: "best",
  reason: "best",
  audit: "best",
};

/**
 * Resolves the concrete model for a stage against an engine profile: a per-role
 * override when the engine sets one, else the role's base intelligence tier.
 * Unknown stage names fall back to the `best` model (unchanged from ADR-0010).
 */
export function resolveModel(profile: EngineProfile, stage: string): string {
  const role = STAGE_ROLE[stage];
  if (role === undefined) {
    return profile.models.best;
  }
  return profile.modelRoles[role] ?? profile.models[ROLE_TIER[role]];
}
