# AGENTS.md

Guidance for AI coding agents (Claude Code, Codex, etc.) working in this repo.
This is the canonical instruction file; `CLAUDE.md` points here.

Site Builder is a Bun + TypeScript CLI (`sb`) that generates working prototype
Astro websites for prospective freelance clients. It orchestrates deterministic
code (crawl, screenshots, deploy) and headless Claude (`claude -p`) for the
AI-heavy stages.

## Read these first

- **`CONTEXT.md`** — the ubiquitous language. Every domain term (Client, Site,
  Site Version, Kit, Design Brief, Client Profile, Field status, Asset, Viewport
  Profile, …) is defined here, each with an **_Avoid_** list of words *not* to
  use. This naming is enforced throughout the code, comments, CLI text, and
  commits — match it exactly; do not introduce synonyms.
- **`docs/adr/000N-*.md`** — the binding architectural decisions. Code comments
  cite them as `ADR-000N`; read the ADR before changing anything that cites it.
  The big ones: 0001 (engine), 0002 (pipeline/resume), 0003 (storage/state),
  0004 (deploy), 0005 (Kit), 0006 (design intelligence).
- **`docs/build-plan.md`** — phase order (0–9) and milestones. **`docs/roadmap.md`**
  — what is *explicitly out of scope for v1*; don't build these without being asked.
- **`NOTES.md`** — current open TODOs.

## Commands

```bash
bun run sb -- <args>          # run the CLI (e.g. bun run sb -- config doctor)
bun test                      # all tests
bun test test/state.test.ts   # a single test file
bun test -t "resume"          # tests matching a name pattern
bun run lint                  # biome check (lint + format check)
bun run lint:fix              # biome autofix
bun run typecheck             # tsc --noEmit
bun run engine:smoke          # exercise the real claude -p engine end-to-end
```

Runtime is **Bun**, not Node. TypeScript runs directly; intra-repo imports use
**explicit `.ts` extensions** (`import { x } from "./foo.ts"`). Strict tsconfig
(`noUncheckedIndexedAccess`, `verbatimModuleSyntax`). Biome formats: 2-space,
100-col, double quotes, always-semicolons, trailing commas. Run lint + typecheck
before considering a change done.

## Architecture

**Layered request flow** — keep logic in the right layer:

```
bin/sb.ts → src/cli.ts (router) → src/commands/* (parse args, load config,
  assemble RunContext) → src/pipeline/orchestrator.ts (runs stages, owns state)
  → src/pipeline/stages/* (thin adapters) → domain modules
  (src/ingest, src/synthesize, src/generate) where the real work lives
```

A `stages/*` file should stay thin: read inputs off disk, delegate to its domain
module, declare its `outputs()`. Don't put business logic in the stage adapter.

**The pipeline** (ADR-0002) is a fixed six-stage sequence in two phases, defined
in `src/pipeline/pipeline.ts`:

- **Context phase** — `init → ingest → synthesize`. Client-level; run once per
  Client. State at `<client>/state.json`.
- **Generation phase** — `generate → audit → deploy`. Produces one Site Version.
  State at `<client>/sites/vN/state.json`.

Resume is at **stage boundaries**, never mid-conversation: each stage reads prior
stages' on-disk artifacts as its input. On resume the failed stage's own
`outputs()` are deleted (clear-own-output) while earlier artifacts are kept
(keep-prior). A stage's `outputs()` must **never** include a `state.json`.

**The engine** (`src/engine/`, ADR-0001). AI stages shell out to the `claudey`
wrapper (`claude -p` in a container) — *not* the Agent SDK and *not* a metered
API key — to ride the developer's subscription auth. `runEngine` spawns it,
feeds the prompt on **stdin** (never a positional), and parses `stream-json` into
a success/failure verdict; it never rejects. Model is chosen **per stage**
(`config.models`): Opus for generate/audit, Sonnet for synthesize/asset
classification. Containment is delegated to `claudey`, so no permission flags are
sent by default. `src/engine/stage.ts` scrubs nested-Claude env markers.

**Storage & state** (`src/storage/`, ADR-0003). The Root directory of per-Client
folders *is* the registry — no central index file; CRM reads scan
`<root>/*/client.json`. Per Client, two files are deliberately split:
`client.json` (human/AI-editable CRM facts) vs `state.json` (machine-managed
pipeline state, never hand-edited). `layout.ts` is the single source of on-disk
paths and the `slugify` keying.

**`generate` + the Kit** (ADR-0005). `generate` copies the hand-maintained
**`kit/`** (Astro 6 + Tailwind v4) into `sites/vN/`, has the engine build on top
of it, sources imagery, and gates on `astro build`. The Kit sets the *quality
floor* (SEO, a11y, perf via `astro:assets`, design tokens, component primitives)
but **not the look** — per-Client visual identity comes from the Design Brief and
instruction, never baked in. `kit/` is its own Astro project with its own
`CLAUDE.md`; read it before touching the Kit. Design intelligence (palettes,
fonts, a11y guardrails) comes from the installed `ui-ux-pro-max` skill at
generate time (ADR-0006), so `sb`'s appended system prompt stays thin.

**Shared helpers, reused across stages:** `src/astro/run.ts` (the `npm install` +
`astro build` compile gate — used by `generate`, reused by `audit`),
`src/playwright/screenshot.ts` (native-resolution screenshots per Viewport
Profile — used by `ingest`, reused by `audit`). Improving these or the Kit raises
the floor for every Site at once.

## Testing posture

Deterministic core (config, state/resume, crawl/markdown, doc extraction) gets
real **unit tests**. AI stages are tested **offline**: the seams are dependency
injection — `RunContext.engine` (an `EngineRunner`) and `RunContext.buildSite`
(a `SiteBuilder`) default to the real implementations in production, but tests
inject fakes (`test/fixtures/fake-*`) that simulate the model writing its on-disk
artifacts and stub the npm/Astro build. **Never call the real `claude -p` or shell
out to npm from a test.** Assert on artifact *shape* and gates (valid JSON,
build passes, file present), not on exact AI prose.
