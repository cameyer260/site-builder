# Pluggable AI-CLI engines (adapter per CLI)

The AI-heavy stages can run on one of three interchangeable headless coding-agent CLIs — **claudey** (default), **codey** (a Codex/`codex exec` wrapper), and **opencode** — selected per run with `--engine`. ADR-0001's reasoning (subprocess not SDK, ride subscription auth, one-shot stateless stages) is unchanged and now generalizes beyond Claude; this ADR records how the one-engine design became many.

## What varies, and what doesn't

Every Engine is still a one-shot, stateless invocation that reads prior stages' on-disk artifacts (ADR-0001/0002 unchanged — the pipeline, resume, and stage isolation are identical regardless of Engine). Only the **I/O dialect** differs, and it is isolated behind a per-CLI adapter (`ADAPTERS[kind]`) that owns three things:

- **Invocation** — claudey: `claude -p`, prompt on **stdin**, `--effort xhigh`. codey: `codex exec "<prompt>"` (prompt **positional**), `-c model_reasoning_effort=xhigh` (note: `--effort` is not a valid codex exec flag), `--skip-git-repo-check`. opencode: `opencode run "<prompt>"`, `--variant max`, `--dangerously-skip-permissions`. (claudey effort is `xhigh` — Anthropic's recommended coding level; codey uses a config key/value for the equivalent; opencode's `--variant max` is opencode's own abstraction — it selects the highest-effort mode available on whichever underlying model is configured, if that knob exists.)
- **System prompt** — claudey: `--append-system-prompt`. codey and opencode: **prepended** to the prompt (neither CLI has a per-call system-prompt flag).
- **Verdict** — claudey: parse `stream-json` for a `result` event with `subtype: success` (+ clean exit). codey/opencode: parse `--json` / `--format json` for a terminal `turn.failed`/`error` event, backstopped by a **non-zero exit code**.

**Env scrubbing is not per-adapter.** Each agent CLI sets "I am running" env vars on itself — Claude Code sets `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SESSION_ID`, and others; codey and opencode have analogous markers. When an agent runs `sb` to validate its own work — which agent CLIs routinely do — those vars are present in `sb`'s environment and would leak into the engine subprocess, making it behave as a nested session of the outer agent rather than a standalone invocation. (This is harmless in a normal host-shell run of `sb`, where none of those vars are set.) To prevent it, a single combined `NESTED_AGENT_MARKERS` list — the union of all three CLIs' markers — is unset before every engine spawn. Unsetting a var that isn't present is a no-op, so one shared list covers all three adapters without per-adapter logic.

The `EngineRunner` seam signature is preserved byte-for-byte (`(engineBin, opts) => Promise<EngineResult>`); `EngineOptions` gains an optional `engine` kind that defaults to `"claudey"`, so every existing stage and test is untouched.

## Configuration

`config.json` is a registry of stable **reference data** (`defaultEngine` + `engines.<kind>.{bin, models: { best, small }}`, seeded from code `DEFAULTS`), not per-run state. The per-run **selection** (`--engine`, falling back to `defaultEngine`) lives on `RunContext`, so concurrent runs on different Engines never collide. Models are a two-tier abstraction (`best`/`small`) with a fixed stage→tier table in code (`generate`/`audit`/`synthesize`→best, `assetClassification`/`brief`→small); each Engine fills both tiers with its own model ids and always runs at its maximum effort.

## Considered options

- **Adapter per CLI (chosen).** Keeps subscription-auth billing across all three (each wrapper rides its own subscription), preserves stage isolation, and contains all divergence in small pure functions.
- **A unified API gateway / LLM router.** Rejected: it would force metered API-key billing (the exact cost constraint ADR-0001 exists to avoid) and discard the containment the `claudey`/`codey` Docker wrappers already provide.

## Consequences

- **claudey is the design-quality default** and the only Engine with a rate-limit-stall watchdog (it is the only one that emits a parseable throttle event; ADR-0001). codey/opencode have no parseable rate-limit signal — they stall silently or fail, so they rely on the stage `timeoutMs` alone.
- Verdict trust on codey/opencode leans on **exit code + terminal event**, which is safe because the stages already re-gate on real artifacts (`astro build`, valid `profile.json`), so a missed parsing nuance cannot pass a broken Site. Best-effort AI calls must genuinely honor this too, not just the hard-gated ones — ADR-0014 fixes a case (asset classification) where the code still trusted the engine's own `ok` verdict over the artifact it wrote, and a real opencode bug turned that gap into recurring lost Assets.
- Design intelligence requires the `ui-ux-pro-max` skill in **whichever harness the selected Engine runs in** (see ADR-0006), not just Claude Code.
- Engine selection is **not persisted**; a `resume` with no `--engine` uses `defaultEngine`, which is correct because stages are engine-agnostic at their on-disk boundaries.
