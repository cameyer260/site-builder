# Two-phase, six-stage pipeline with stage-boundary resume

The tool is structured as a fixed six-stage pipeline split into two phases:

- **Context phase** — `init` → `ingest` → `synthesize`. Produces Client-level artifacts (crawled/ingested raw material, downloaded Assets, the Client Profile + Checklist gaps). Run once per Client; re-run only when inputs change.
- **Generation phase** — `generate` → `audit` → `deploy`. Produces one Site Version from the existing context. Run once per variant.

**Why the split.** Context is about the Client and is identical no matter how many site variants we try; the site is the per-variant output. Separating them means generating a second variant ("darker look") reuses ingest + synthesize for free and only re-runs `generate → audit → deploy` into a new `sites/vN/`. It also localizes the expensive/slow work (crawl, AI synthesis) to the phase that rarely needs repeating.

**Resume is at stage boundaries, not mid-conversation.** Each stage reads the prior stages' on-disk artifacts as its input, so a failed run is resumed by re-running from the last incomplete stage with fresh AI context. This is why `claude -p` (see ADR-0001) is sufficient — no session continuity is needed.

**Three continuation operations, deliberately distinct:**
- `sb build` — smart all-in-one: creates the Client if new, runs the context phase (or skips it if context exists and no new inputs are given), an optional interactive QA session, then the generation phase, then deploy.
- `sb resume` — continue a failed run from its last completed stage.
- `sb variant` — run the generation phase only, into a new Site Version.

Keeping `resume` and `variant` as explicit verbs (not flags on `build`) prevents accidental re-crawling or overwriting.

**Determinism boundary.** `ingest` and `deploy` are pure code; `synthesize` and `generate` mix code with `claude -p`; `audit` mixes code (screenshots via the Playwright script) with `claude -p`. AI is used only where deterministic code cannot do the job, to conserve the subscription's usage.
