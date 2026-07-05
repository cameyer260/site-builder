# AGENTS.md

Guidance for AI coding agents (Claude Code, Codex, etc.) working in this repo.
This is the canonical instruction file; `CLAUDE.md` points here.

Site Builder is a Bun + TypeScript CLI (`sb`) that generates working prototype
Astro websites for prospective freelance clients. It orchestrates deterministic
code (crawl, screenshots, deploy) and a configurable headless AI coding-agent
CLI — the **Engine** (`claudey` by default, or `codey`/`opencode` via `--engine`)
— for the AI-heavy stages.

## Read these first

- **`CONTEXT.md`** — the ubiquitous language. Every domain term (Client, Site,
  Site Version, Kit, Design Brief, Client Profile, Field status, Asset, Viewport
  Profile, …) is defined here, each with an **_Avoid_** list of words *not* to
  use. This naming is enforced throughout the code, comments, CLI text, and
  commits — match it exactly; do not introduce synonyms.
- **`docs/adr/000N-*.md`** — the binding architectural decisions. Code comments
  cite them as `ADR-000N`; read the ADR before changing anything that cites it.
  The big ones: 0001 (engine), 0002 (pipeline/resume), 0003 (storage/state),
  0004 (deploy), 0005 (Kit), 0006 (design intelligence), 0007 (audit:
  Lighthouse as evidence, not a gate), 0008 (smart-build decision table +
  CRM/GitHub continuation operations), 0009 (idiomatic functional TS over
  literal OO-SOLID — cleanups are DRY/consistency behind a frozen behavioral
  contract, not re-architecture), 0010 (pluggable Engines: `claudey`/`codey`/
  `opencode` behind a per-CLI adapter, selected per run with `--engine`), 0011
  (captured Assets are staged into the Site Version by code before the build
  call runs, not copied by the Engine).
- **`docs/roadmap.md`** — what is *explicitly out of scope for v1*; don't build these
  without being asked.

## Commands

```bash
bun run sb -- <args>          # run the CLI (e.g. bun run sb -- config doctor)
bun test                      # all tests
bun test test/state.test.ts   # a single test file
bun test -t "resume"          # tests matching a name pattern
bun run lint                  # biome check (lint + format check)
bun run lint:fix              # biome autofix
bun run typecheck             # tsc --noEmit
bun run engine:smoke          # exercise the engine end-to-end (add --engine <kind> for codey/opencode)
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

**The Engine** (`src/engine/`, ADR-0001/0010). AI stages shell out to a headless
coding-agent CLI — *not* an SDK and *not* a metered API key — to ride the
developer's subscription auth. The Engine is **pluggable**: `--engine` selects one
of three interchangeable one-shot CLIs (default `claudey`; also `codey` and
`opencode`), each behind a per-CLI adapter in `ADAPTERS` that owns its invocation
dialect (claudey `-p` + prompt on **stdin**; codey `exec` + positional prompt;
opencode `run`), system-prompt delivery (`--append-system-prompt` for claudey;
prepended to the prompt for codey and opencode), effort flag (claudey/codey
`--effort xhigh`; opencode `--variant max`), and result parsing (claudey `stream-json`
`result` event + rate-limit watchdog;
codey/opencode `--json`/`--format json` terminal event + non-zero exit). `runEngine`
keeps all process lifecycle (spawn, process-group kill, timeout, drain) generic and
never rejects. Models are a two-tier abstraction — `best` (generate/audit/synthesize) and
`small` (asset classification / Design Brief derivation) — with a fixed stage→tier table in code and
each Engine's concrete ids in `config.engines.<kind>.models`. The per-run selection
lives on `RunContext` (config holds only `defaultEngine` + per-engine reference data)
and is **not** persisted across resume. Containment is delegated to each wrapper, so
no permission flags are sent by default; `src/engine/stage.ts` scrubs a single
combined list of nested-session env markers (`NESTED_AGENT_MARKERS` — Claude + Codex
+ OpenCode) before every spawn.

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

**`audit`** (`src/audit/`, ADR-0007). Runs against the locally built Site:
`src/astro/preview.ts` serves `dist/`, then one deterministic pass
(`inspect.ts`) reuses the screenshot component and runs **axe-core** + a
broken-link/asset check into `audit/checks.json`. A single engine call reviews
*and* applies one fix pass (writing `audit/audit.md`); `astro build` re-gates —
the only hard gate. *After* the re-gate, Lighthouse (`lighthouse.ts`) records
the **Scorecard** per form factor (`audit/lighthouse.json` + a table prepended
to `audit.md`) as non-gating evidence — a low score is recorded, never blocking.
Review + fix only; the multi-pass loop and score gating are deferred. Like
`generate`, the heavy I/O is behind injectable seams — `RunContext.inspectSite`
and `RunContext.runLighthouse` (alongside `engine`/`buildSite`) default to the
real impls and are faked in tests.

**`deploy`** (`src/deploy/`, ADR-0004) — pure code, no AI, no GitHub. This is
v1's core promise: Inputs → shareable live link. `deploy.ts` ensures the Site
Version has a built `dist/` (rebuilding via `buildSite` only if a standalone
resume lost it), then `wrangler.ts` Direct-Uploads it to Cloudflare Pages
(`wrangler pages project create` — idempotent, "already exists" is fine — then
`wrangler pages deploy`), parses the `*.pages.dev` URL from wrangler's output,
and records it on the Client's Site Version pointer via
`recordSiteVersion` (`client.json`, never a stage output → survives resume). One
Pages project per Client (`pagesProjectName` = the slug, capped at 58). The
wrangler subprocess is behind the `RunContext.deploySite` seam, faked in tests.
`sb config` verifies wrangler is present + authed.

**Shared helpers, reused across stages:** `src/astro/run.ts` (the `npm install` +
`astro build` compile gate — `generate`'s gate, `audit`'s re-gate),
`src/astro/preview.ts` (the `astro preview` server `audit` serves the built Site
from), `src/playwright/screenshot.ts` (native-resolution screenshots per Viewport
Profile — `ingest`'s crawl, `audit`'s inspection), `src/util/git.ts`
(per–Site-Version commits for `generate` and `audit`), and `runCommand` in
`src/astro/run.ts` (the generic spawn/capture `deploy` reuses for wrangler).
Improving these or the Kit raises the floor for every Site at once.

**Continuation, CRM & GitHub** (`src/commands/*`, `src/github/`, ADR-0008). Three
pipeline verbs stay distinct: `build` is smart (`smartBuild` in the orchestrator
picks **new / refresh / continue / noop** from on-disk state — refresh forks a new
Site Version, continue resumes the latest in place), `resume` strictly continues a
failed run, `variant` forks a new Site Version from the existing context without
re-crawling. CRM commands (`list`/`show`/`set`/`edit`, plus `status`) are thin
reads/writes over `<slug>/client.json` (the Root is the registry); `set`/`edit`
touch only the CRM facts, never `state.json`. GitHub is opt-in and orthogonal to
deploy (ADR-0004): `--github` / `sb push` runs `gh repo create … --push` from a
Site Version's git repo and records the remote via `recordSiteVersion`, behind the
injectable `GitHubPublisher` seam so tests never shell out. `gh` is a non-required
`config doctor` check.

## Testing posture

Deterministic core (config, state/resume, crawl/markdown, doc extraction) gets
real **unit tests**. AI stages are tested **offline**: the seams are dependency
injection — `RunContext.engine` (an `EngineRunner`), `RunContext.buildSite`
(a `SiteBuilder`), `audit`'s `RunContext.inspectSite` / `RunContext.runLighthouse`,
and `deploy`'s `RunContext.deploySite` (a `DeployRunner`) default to the real
implementations in production, but tests inject fakes (`test/fixtures/fake-*`)
that simulate the model writing its on-disk artifacts and stub the npm/Astro
build, the preview+browser inspection, the Lighthouse run, and the wrangler
upload. **Never call the real `claude -p`, shell out to npm/wrangler, or launch a
browser/Chrome from a test.** Assert on artifact *shape* and gates (valid JSON, build passes, file
present), not on exact AI prose.
