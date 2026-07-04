# Architecture

How Site Builder is put together. This is the developer-facing map; the
operator-facing guide is the [README](../README.md), the vocabulary is
[CONTEXT.md](../CONTEXT.md), and the binding decisions are in
[docs/adr/](adr/). Where a decision is load-bearing, this doc cites the ADR
rather than restating it — read the ADR before changing anything that cites it.

## The shape in one diagram

```
bin/sb.ts
  └─ src/cli.ts                      router: argv → command
       └─ src/commands/*             parse args, load config, assemble RunContext
            └─ src/pipeline/orchestrator.ts   runs stages, owns state.json
                 └─ src/pipeline/stages/*     thin adapters
                      └─ domain modules:      where the real work lives
                         src/ingest/  src/synthesize/  src/generate/
                         src/audit/   src/deploy/
```

**Keep logic in the right layer.** A `commands/*` file parses flags and builds a
`RunContext`. The orchestrator owns the run loop and state transitions. A
`stages/*` file stays *thin* — read inputs off disk, delegate to its domain
module, declare its `outputs()`. Business logic lives in the domain modules, not
the stage adapters.

Runtime is **Bun**. TypeScript executes directly (no build step); intra-repo
imports use explicit `.ts` extensions. Strict tsconfig
(`noUncheckedIndexedAccess`, `verbatimModuleSyntax`). Biome formats: 2-space,
100-col, double quotes, semicolons, trailing commas.

## The pipeline (ADR-0002)

A fixed **six-stage sequence** in two phases, defined once in
`src/pipeline/pipeline.ts`:

- **Context phase** — `init → ingest → synthesize`. Client-level, run once per
  Client. State at `<client>/state.json`.
- **Generation phase** — `generate → audit → deploy`. Produces one Site Version.
  State at `<client>/sites/vN/state.json`.

The orchestrator (`src/pipeline/orchestrator.ts`) walks `STAGES`, and for each:
marks the stage `running` and flushes state → calls `stage.run(ctx)` → marks
`completed`/`failed` and flushes. The generation-phase state file (and its `vN/`
directory) is created lazily the first time a generation stage runs, so the
phase only materializes when reached.

### Resume is at stage boundaries, never mid-conversation

Each stage reads the *prior* stages' on-disk artifacts as its input. There is no
mid-run state to preserve. On resume (`findResumeStage` → first non-`completed`
stage across both phase files):

- **clear-own-output** — the failed stage's own `outputs(ctx)` are deleted before
  re-running.
- **keep-prior** — earlier stages' artifacts are left intact and re-read.

A stage's `outputs()` must **never** include a `state.json` (state is managed by
the orchestrator, not owned by a stage) and never include the `client.json` CRM
record (which must survive a refresh). This invariant is what makes resume safe.

### `smartBuild`: one verb, four actions (ADR-0008)

`sb build` calls `smartBuild`, which reads on-disk state and picks **new /
refresh / continue / noop** — see the decision table in
[ADR-0008](adr/0008-smart-build-and-continuation.md). It mutates `ctx.version` to
the Site Version it targets. The other continuation verbs stay distinct so a
continuation is always explicit:

- `runVariant` (`sb variant`) — runs the Generation phase only into a fresh
  `vN+1`; never touches the Context phase, never re-crawls.
- `resumePipeline` (`sb resume`) — strictly continues the latest failed run from
  its first unfinished stage.

A **refresh** forks a *new* Site Version (re-run Context from `ingest`, then a new
`vN+1`); **continue** resumes the latest version in place (its git history holds
the increments). The reasoning is in ADR-0008.

## The engine (`src/engine/`, ADR-0001)

AI stages shell out to the `claudey` wrapper (`claude -p` in a container) — *not*
the Agent SDK and *not* a metered API key — to ride the developer's subscription
auth.

- `runEngine` (`runner.ts`) spawns the wrapper, feeds the prompt on **stdin**
  (never as a positional), parses `stream-json`, and returns a success/failure
  verdict — it **never rejects**, so a stage decides what to do with a failure.
- Model is chosen **per stage** from `config.models`: Opus for generate/audit/synthesize,
  Sonnet for asset classification / Design Brief derivation.
- Containment is delegated to `claudey` (a bypass-permissions container scoped to
  its mounts), so the tool sends **no permission flags** by default. The blast
  radius is the container mount scope.
- `stage.ts` scrubs nested-Claude env markers so a `claude -p` run launched from
  inside Claude Code behaves.

## Storage & state (`src/storage/`, ADR-0003)

The **Root** directory of per-Client folders *is* the registry — there is no
central index file. CRM reads scan `<root>/*/client.json` (`listClientDirs`).
`layout.ts` is the single source of on-disk paths and the `slugify` keying;
nothing else should hand-build a path.

Per Client, two files are deliberately split:

- **`client.json`** (`client.ts`) — human/AI-editable CRM facts: name, contact,
  Inputs, socials, reviews, notes, and Site Version pointers (`deployUrl`,
  `repoPath`, `remote`). Zod-validated on every read and write. `recordSiteVersion`
  upserts a Site Version pointer (used by deploy and `--github`); it is **never a
  stage output**, so it survives resume and refresh.
- **`state.json`** (`state.ts`) — machine-managed pipeline state: per-stage
  status (`pending`/`running`/`completed`/`failed`), attempts, timestamps,
  errors, and a `lastRun` summary. Never hand-edited.

The split guarantees a manual or AI edit of CRM facts can never corrupt the
resume state, and the pipeline can never clobber the user's notes. On-disk layout
is in the [README](../README.md#on-disk-layout) and ADR-0003.

## The stages

Each is a thin adapter over a domain module:

- **`init`** (`stages/init.ts`) — creates the Client folder and registers the
  Client (writes `client.json` from `ctx.inputs`). Pure code. Its `outputs()` are
  empty by design so a refresh never clears the CRM record.
- **`ingest`** (`src/ingest/`) — Playwright crawl (sitemap-first → internal-link
  fallback, same-origin, page cap), HTML→Markdown, native-resolution screenshots
  per Viewport Profile, asset download (`<img>` + `og:image` + favicons), document
  extraction (`unpdf`/`mammoth`/txt/md), and `--notes`, normalized into `ingest/`.
  Pure code.
- **`synthesize`** (`src/synthesize/`) — engine call A classifies + renames image
  Assets (vision, Sonnet); engine call B writes the Client Profile (`profile.md` +
  `profile.json` field statuses) and a "what we still need to know" Checklist.
- **`generate`** (`src/generate/`, ADR-0005/0006) — derives the Design Brief
  (`.site-builder/brief.md`, brand-color extraction, `--vibe`/`--style`), copies
  the [Kit](kit.md) into `sites/vN/`, `git init`s it, has the engine build on top
  invoking the `ui-ux-pro-max` skill, sources imagery (`pexels.ts` three-tier
  rule, slots declared in `.site-builder/images.json`), and gates on
  `astro build`. Pipeline-internal artifacts (the Brief, the image manifest) live
  under `.site-builder/` (`artifacts.ts`) rather than the project root, so they
  read as tool metadata rather than mystery files once the Site Version evolves
  into a production repo. An optional [QA session](../CONTEXT.md) (`qa.ts`) gates
  between phases on an interactive TTY.
- **`audit`** (`src/audit/`, ADR-0007) — serves the built `dist/`
  (`src/astro/preview.ts`), one deterministic pass (`inspect.ts`: reused
  screenshot component + axe-core + broken-link/asset check → `checks.json`), a
  single engine review+fix pass (`audit.md`), `astro build` re-gate, then the
  Lighthouse **Scorecard** (`lighthouse.json` + a table prepended to `audit.md`)
  as **non-gating** evidence. `astro build` is the only hard gate.
- **`deploy`** (`src/deploy/`, ADR-0004) — pure code, no AI, no GitHub. Ensures a
  built `dist/`, then `wrangler.ts` Direct-Uploads to Cloudflare Pages
  (`pages project create` — idempotent — then `pages deploy`), parses the
  `*.pages.dev` URL, and records it via `recordSiteVersion`. One Pages project per
  Client (slug, capped at 58 chars).

### Shared helpers — improving these raises the floor for every Site

- `src/astro/run.ts` — the `npm install` + `astro build` compile gate (generate's
  gate, audit's re-gate) and the generic `runCommand` spawn/capture (deploy reuses
  it for wrangler).
- `src/astro/preview.ts` — the `astro preview` server audit serves the built Site
  from.
- `src/playwright/screenshot.ts` — native-resolution screenshots per Viewport
  Profile, reused by ingest's crawl and audit's inspection.
- `src/util/git.ts` — per–Site-Version commits for generate and audit.

## Continuation, CRM & GitHub (`src/commands/*`, `src/github/`, ADR-0008)

CRM commands (`list`/`show`/`set`/`edit`, plus `status`) are thin reads/writes
over `<slug>/client.json`; `set`/`edit` touch only CRM facts, never `state.json`.
GitHub is opt-in and orthogonal to deploy (ADR-0004): `--github` / `sb push` runs
`gh repo create … --push` from a Site Version's git repo and records the remote,
behind the injectable `GitHubPublisher` seam.

## Seams & testing posture

The deterministic core (config, state/resume, crawl/markdown, doc extraction,
the decision table) gets real **unit tests**. AI and heavy-I/O stages are tested
**offline** via dependency-injection seams on `RunContext`, each defaulting to
the real implementation in production and faked in tests:

| Seam | Production | Faked in tests so we don't… |
|---|---|---|
| `engine` (`EngineRunner`) | `runEngine` (`claude -p`) | …call the real model |
| `buildSite` (`SiteBuilder`) | `npm install` + `astro build` | …shell out to npm/Astro |
| `inspectSite` (`SiteInspector`) | preview + screenshots + axe + link check | …serve the Site or launch a browser |
| `runLighthouse` (`LighthouseRunner`) | Lighthouse via chrome-launcher | …launch Chrome |
| `deploySite` (`DeployRunner`) | wrangler Direct Upload | …shell out to wrangler / hit the network |
| `GitHubPublisher` | `gh repo create … --push` | …shell out to `gh` |

The fakes (`test/fixtures/fake-*`) simulate the model writing its on-disk
artifacts and stub the build/preview/Lighthouse/wrangler steps. **Never call the
real `claude -p`, shell out to npm/wrangler/gh, or launch a browser from a test.**
Assert on artifact *shape* and gates (valid JSON, build passes, file present),
not on exact AI prose. `SB_STUB_FAIL=<stage>` forces a stage to throw, for
exercising resume/state behavior.

```bash
bun test                      # all tests
bun test test/state.test.ts   # one file
bun test -t "resume"          # by name pattern
bun run engine:smoke          # exercise the real claude -p engine end-to-end
```
