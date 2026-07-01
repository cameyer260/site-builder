# Engine: `claude -p` subprocess, not the Agent SDK

> **Extended by [ADR-0010](./0010-pluggable-ai-cli-engines.md).** The subprocess
> approach below is unchanged and still the design, but the Engine is now
> pluggable: `claudey` is the default of three interchangeable CLIs (also `codey`
> and `opencode`), each a one-shot subprocess behind a common adapter.

The AI-heavy stages are invoked by shelling out to the `claude -p` (headless print mode) binary, rather than importing the Claude Agent SDK. This rides the developer's existing Claude Code subscription auth instead of metered Anthropic API-key billing, which is the primary cost constraint for this tool.

Resumability is handled at the pipeline-stage level, not via Claude session continuity: each stage is a fresh `claude -p` invocation that reads the prior stages' on-disk artifacts as its context. There is no mid-conversation state to preserve, so the SDK's richer session model buys us nothing here.

Trade-off accepted: less programmatic control and structured-output ergonomics than the SDK, in exchange for subscription billing and a simpler stage-isolation story. MCP (Playwright), skills, and `stream-json` output are all still available through `claude -p` flags.

## Concrete command and containment

The binary invoked is the developer's `claudey` wrapper — Claude Code running inside a Docker container with bypass-permissions enabled, with filesystem access limited to the mounted directory. The tool shells out to `claudey -p ...`, not raw `claude`.

This means autonomy is safe by construction: the spawned agent can edit files and run bash (`bun`/`astro`/`git`/`wrangler`/`lighthouse`) unattended, but the container's mount scope is the blast radius. No per-call permission-mode/allowlist machinery is needed in the tool itself — containment is delegated to `claudey`.

## Model per stage

Model is chosen per stage to spend the subscription's usage where it moves quality. This is expressed as a two-tier abstraction (a **best** tier and a **small** tier) with the stage→tier mapping fixed in code and each Engine's concrete models configurable in `config.json` (see ADR-0010):

- **best** → `generate`, `audit`, `synthesize` (creative build, judgment, and deep-research synthesis). claudey: Opus 4.8.
- **small** → asset-classification and the `generate` Design Brief derivation (lightweight structured extraction). claudey: Sonnet 5.
