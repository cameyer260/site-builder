import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { readJsonFile } from "../util/json.ts";
import { nowIso } from "../util/time.ts";

/**
 * `state.json` — machine-managed pipeline state (ADR-0003). Never hand-edited.
 * One file per phase level: `<client>/state.json` (context) and
 * `<client>/sites/vN/state.json` (generation).
 */

export const STAGE_STATUSES = ["pending", "running", "completed", "failed"] as const;
export type StageStatus = (typeof STAGE_STATUSES)[number];

export const StageRecordSchema = z.object({
  status: z.enum(["pending", "running", "completed", "failed"]),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  attempts: z.number().int().nonnegative().default(0),
  error: z.string().optional(),
});
export type StageRecord = z.infer<typeof StageRecordSchema>;

export const PhaseSchema = z.enum(["context", "generation"]);

export const LastRunSchema = z.object({
  status: z.enum(["running", "completed", "failed"]),
  stage: z.string().optional(),
  at: z.string(),
  error: z.string().optional(),
});

export const StateSchema = z.object({
  phase: PhaseSchema,
  /** Present for generation-phase state; the Site Version this file tracks. */
  version: z.number().int().positive().optional(),
  /**
   * Present on the context-phase state while a refresh is in flight: the Site
   * Version the run is building toward. The generation version dir is only
   * materialized once a generation stage runs, so without this a refresh that
   * dies in the context phase leaves no trace of its target Version and a later
   * resume would fall back to the previous one (regenerating over it).
   */
  targetVersion: z.number().int().positive().optional(),
  stages: z.record(z.string(), StageRecordSchema),
  lastRun: LastRunSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type State = z.infer<typeof StateSchema>;

export function emptyState(
  phase: z.infer<typeof PhaseSchema>,
  stageNames: string[],
  version?: number,
): State {
  const stages: Record<string, StageRecord> = {};
  for (const name of stageNames) {
    stages[name] = { status: "pending", attempts: 0 };
  }
  const ts = nowIso();
  return { phase, version, stages, createdAt: ts, updatedAt: ts };
}

export function readState(statePath: string): State | null {
  if (!existsSync(statePath)) {
    return null;
  }
  return readJsonFile(statePath, StateSchema, { label: `state.json at ${statePath}` });
}

export function writeState(statePath: string, state: State): void {
  state.updatedAt = nowIso();
  const validated = StateSchema.parse(state);
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(validated, null, 2)}\n`);
}

/** Loads the state at `statePath`, creating an empty one if it does not exist. */
export function ensureState(
  statePath: string,
  phase: z.infer<typeof PhaseSchema>,
  stageNames: string[],
  version?: number,
): State {
  const existing = readState(statePath);
  if (existing) {
    return existing;
  }
  const fresh = emptyState(phase, stageNames, version);
  writeState(statePath, fresh);
  return fresh;
}

function recordFor(state: State, stage: string): StageRecord {
  return state.stages[stage] ?? { status: "pending", attempts: 0 };
}

export function markRunning(state: State, stage: string): void {
  const rec = recordFor(state, stage);
  rec.status = "running";
  rec.startedAt = nowIso();
  rec.attempts += 1;
  rec.completedAt = undefined;
  rec.error = undefined;
  state.stages[stage] = rec;
  state.lastRun = { status: "running", stage, at: nowIso() };
}

export function markCompleted(state: State, stage: string): void {
  const rec = recordFor(state, stage);
  rec.status = "completed";
  rec.completedAt = nowIso();
  rec.error = undefined;
  state.stages[stage] = rec;
  state.lastRun = { status: "completed", stage, at: nowIso() };
}

export function markFailed(state: State, stage: string, error: string): void {
  const rec = recordFor(state, stage);
  rec.status = "failed";
  rec.error = error;
  state.stages[stage] = rec;
  state.lastRun = { status: "failed", stage, at: nowIso(), error };
}
