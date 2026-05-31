import { auditStage } from "./stages/audit.ts";
import { deployStage } from "./stages/deploy.ts";
import { generateStage } from "./stages/generate.ts";
import { ingestStage } from "./stages/ingest.ts";
import { initStage } from "./stages/init.ts";
import { synthesizeStage } from "./stages/synthesize.ts";
import type { Phase, Stage } from "./types.ts";

/**
 * The fixed six-stage pipeline (ADR-0002), in execution order. The first three
 * stages form the Context phase (state at `<client>/state.json`); the last
 * three form the Generation phase (state at `<client>/sites/vN/state.json`).
 */
export const STAGES: readonly Stage[] = [
  initStage,
  ingestStage,
  synthesizeStage,
  generateStage,
  auditStage,
  deployStage,
];

export const STAGE_NAMES: readonly string[] = STAGES.map((s) => s.name);

export function stageNamesFor(phase: Phase): string[] {
  return STAGES.filter((s) => s.phase === phase).map((s) => s.name);
}

export function stageIndex(name: string): number {
  return STAGES.findIndex((s) => s.name === name);
}
