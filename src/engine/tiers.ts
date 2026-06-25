/**
 * Fixed stage→model-tier mapping (ADR-0010). generate/audit use the `best` tier
 * (judgment/creative work); synthesize/assetClassification use the `small` tier
 * (structured extraction). The mapping is in code, not config, so it cannot drift.
 */
export const STAGE_TIER: Record<string, "best" | "small"> = {
  generate: "best",
  audit: "best",
  synthesize: "small",
  assetClassification: "small",
};
