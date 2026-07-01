/**
 * Fixed stage→model-tier mapping (ADR-0010). `generate`, `audit`, and
 * `synthesize` use the `best` tier (judgment / creative / deep research work);
 * `assetClassification` and the `generate` Design Brief sub-call (`brief`) use
 * the `small` tier (structured extraction). The mapping is in code, not config,
 * so it cannot drift.
 */
export const STAGE_TIER: Record<string, "best" | "small"> = {
  generate: "best",
  audit: "best",
  synthesize: "best",
  assetClassification: "small",
  brief: "small",
};
