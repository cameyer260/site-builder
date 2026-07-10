# Asset classification trusts the written artifact, not the engine's exit code

Recurring production symptom on `--engine opencode`: `synthesize`'s asset
classification call would write a fully valid `context/assets.json` — correct
roles, correct singleton logo, real descriptions — and then the surrounding
`opencode run --format json` invocation would report a non-zero exit and print
`EPIPE: broken pipe, write` stack traces to stderr. Root cause is internal to
opencode: a Bun-compiled binary's stdout-event-mirroring path writing to a pipe
that's already closed on its own side, unrelated to whether the classification
itself succeeded (`opencode` issues #31482, #34266, #26855; fix PR #33146
unmerged as of 2026-07-10). It reproducibly hit the same step, across multiple
runs, always the *first* opencode call of a build.

`runSynthesize`'s classification call required `result.ok && parsed` before
trusting the written file, so this false failure discarded a perfectly good
classification every time and fell back to the Fallback Asset (logo) plus
Pexels stock — silently dropping the Client's own captured photography from
the generated Site.

This is the same failure shape ADR-0011 fixed for Asset *staging*: an Engine's
process-level unreliability (there, unreliable instruction-following; here, an
unrelated CLI bug) silently drops a Client's real Assets in favor of a generic
substitute. The fix in both cases is to stop trusting the Engine's own report
of what happened and check the actual on-disk result instead.

## Decision

`runSynthesize`'s classification call (`src/synthesize/synthesize.ts`) now
trusts a schema-valid `context/assets.json` regardless of the engine's `ok`
verdict, logging a warning (not falling back) when the file is valid but the
engine reported an error. It only falls back to the Fallback Asset when
`readClassification` returns null — no file, or one that doesn't parse.

This is safe because `context/` is one of `synthesize`'s declared `outputs()`
and is deleted wholesale before every retry — both a fresh run's first attempt
and `resumePipeline`'s clear-own-output step wipe it first (`orchestrator.ts`).
So there is no stale-artifact risk: whatever `assets.json` exists when this
call reads it was written by *this* invocation, or not written at all.

This also makes good on ADR-0010's own stated rationale for trusting
codey/opencode's exit-code-based verdict at all ("the stages already re-gate
on real artifacts, so a missed parsing nuance cannot pass a broken Site") —
for this specific call, that re-gate hadn't actually been implemented; it is
now.

## Related hardening

Two related fixes landed in the same pass, found while root-causing the
recurring failure:

- **Orphaned engines on cancel.** `runEngine` spawns each engine
  `detached: true` in its own process group so a timeout can reap the whole
  tree (ADR-0001) — but that same detachment means the terminal's own Ctrl-C
  is delivered to `sb`'s process group only, never the engine's. Cancelling a
  build previously orphaned the running engine (observed spinning on the same
  EPIPE, burning CPU/API spend, after the cancel). `runEngine` now registers
  every in-flight call in a module-level set (`killActiveEngines`); a new
  SIGINT/SIGTERM handler in `bin/sb.ts` drains it on shutdown, running each
  engine's existing SIGTERM→SIGKILL escalation before `sb` exits.
- **Stderr diagnostics.** `EngineResult.stderrTail` (a plain last-2000-chars
  window, further sliced to 800 chars in `engineFailureReason`) is now
  `stderrExcerpt`: a head+tail composite. A repeating error — like the
  EPIPE-on-every-write pattern that triggered this investigation — used to
  fill a tail-only window with copies of the *last* repeat, pushing the
  causal first line out of the diagnostic entirely.

## Considered and rejected

- **Wait for the opencode fix.** PR #33146 (`fix(cli): stream run output, add
  empty-text warning, flush race-late parts`) addresses this upstream but is
  unmerged with no ETA; `sb` shouldn't drop real Client Assets in the
  meantime.
- **Retry the classification call on a non-ok result.** Doubles cost/latency
  for a call that, per the evidence here, usually already succeeded — checking
  the artifact is a cheaper and more direct signal than a blind retry.
- **Special-case this specific opencode/EPIPE stderr pattern as benign.**
  Rejected as exactly the fragile, engine-CLI-version-coupled logic ADR-0010's
  adapter design exists to avoid. Checking the artifact is engine-agnostic and
  needs no knowledge of opencode's internals.
