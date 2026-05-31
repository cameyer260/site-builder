import { mkdirSync, rmSync } from "node:fs";
import { relative } from "node:path";
import {
  ensureState,
  markCompleted,
  markFailed,
  markRunning,
  readState,
  type State,
  writeState,
} from "../storage/state.ts";
import { STAGES, stageNamesFor } from "./pipeline.ts";
import type { Phase, RunContext, Stage } from "./types.ts";

export interface RunResult {
  ok: boolean;
  /** Set when ok is false: the stage that failed and its error message. */
  failedStage?: string;
  error?: string;
  /** Stage names completed during this invocation. */
  ran: string[];
}

/**
 * A live handle to one phase's `state.json`: its path, the stage names it
 * tracks, and the in-memory State that gets mutated and flushed as stages run.
 */
interface StateHandle {
  phase: Phase;
  path: string;
  state: State;
}

function contextHandle(ctx: RunContext): StateHandle {
  const path = ctx.paths.state;
  const state = ensureState(path, "context", stageNamesFor("context"));
  return { phase: "context", path, state };
}

/**
 * Lazily creates the Site Version directory and its state file the first time a
 * generation stage runs, so the Generation phase only materializes when reached.
 */
function generationHandle(ctx: RunContext): StateHandle {
  mkdirSync(ctx.paths.versionDir(ctx.version), { recursive: true });
  const path = ctx.paths.versionState(ctx.version);
  const state = ensureState(path, "generation", stageNamesFor("generation"), ctx.version);
  return { phase: "generation", path, state };
}

function flush(handle: StateHandle): void {
  writeState(handle.path, handle.state);
}

/** Runs the pipeline from `startStage` (its name) to the end. */
async function runFrom(ctx: RunContext, startStage: string): Promise<RunResult> {
  const start = STAGES.findIndex((s) => s.name === startStage);
  if (start < 0) {
    throw new Error(`unknown start stage "${startStage}"`);
  }

  const ctxHandle = contextHandle(ctx);
  let genHandle: StateHandle | null = null;
  const handleFor = (phase: Phase): StateHandle => {
    if (phase === "context") {
      return ctxHandle;
    }
    if (!genHandle) {
      genHandle = generationHandle(ctx);
    }
    return genHandle;
  };

  const ran: string[] = [];
  for (const stage of STAGES.slice(start)) {
    const handle = handleFor(stage.phase);
    ctx.log.step(`▶ ${stage.name} [${stage.phase}]`);
    markRunning(handle.state, stage.name);
    flush(handle);

    try {
      await stage.run(ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      markFailed(handle.state, stage.name, message);
      flush(handle);
      ctx.log.error(`stage "${stage.name}" failed: ${message}`);
      return { ok: false, failedStage: stage.name, error: message, ran };
    }

    markCompleted(handle.state, stage.name);
    flush(handle);
    ctx.log.success(`${stage.name} done`);
    ran.push(stage.name);
  }

  return { ok: true, ran };
}

/** Full pipeline run for a new Client (`sb build`). */
export async function runBuild(ctx: RunContext): Promise<RunResult> {
  return runFrom(ctx, STAGES[0]?.name as string);
}

/**
 * Finds the first stage that is not completed, scanning the ordered pipeline
 * against both phase state files. Returns null when everything is complete.
 */
export function findResumeStage(ctx: RunContext): Stage | null {
  const contextState = readState(ctx.paths.state);
  const generationState = readState(ctx.paths.versionState(ctx.version));
  for (const stage of STAGES) {
    const state = stage.phase === "context" ? contextState : generationState;
    if (state?.stages[stage.name]?.status !== "completed") {
      return stage;
    }
  }
  return null;
}

/**
 * Resumes a failed run from its last incomplete stage. Clears that stage's own
 * output first (clear-own-output) while leaving prior stages' artifacts intact
 * (keep-prior), then continues to the end.
 */
export async function resumePipeline(ctx: RunContext): Promise<RunResult> {
  const stage = findResumeStage(ctx);
  if (!stage) {
    ctx.log.success("nothing to resume — pipeline already complete");
    return { ok: true, ran: [] };
  }

  ctx.log.step(`resuming at "${stage.name}"`);
  for (const output of stage.outputs(ctx)) {
    rmSync(output, { recursive: true, force: true });
    ctx.log.info(`cleared prior output: ${relative(ctx.paths.dir, output) || output}`);
  }

  return runFrom(ctx, stage.name);
}

/** Reads both phase states for reporting (`sb status`). */
export function readPipelineStatus(ctx: RunContext): {
  context: State | null;
  generation: State | null;
} {
  return {
    context: readState(ctx.paths.state),
    generation: readState(ctx.paths.versionState(ctx.version)),
  };
}
