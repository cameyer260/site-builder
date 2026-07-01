# Site Builder

A CLI (`sb`) that turns whatever you know about a prospective freelance client's
business into a **working, deployed prototype website** — a fast outreach
mechanism. Point it at an existing site, a few documents, or just some notes, and
it crawls, profiles, designs, builds, audits, and deploys a tailored
[Astro](https://astro.build) site, handing back a shareable `*.pages.dev` link.

It orchestrates deterministic code (crawl, screenshots, deploy) and a
pluggable headless coding-agent CLI for the AI-heavy stages — **`claudey`**
(default), **`codey`** (Codex), or **`opencode`**; select with `--engine`.
Subscription auth, not a metered API key (see
[ADR-0001](docs/adr/0001-claude-p-subprocess-engine.md) and
[ADR-0010](docs/adr/0010-pluggable-ai-cli-engines.md)).

> **The core promise:** `sb build <name> --url …` → a live link. One command,
> Inputs in, deployed prototype out.

---

## Requirements

- **[Bun](https://bun.sh) 1.3+** — the runtime. TypeScript runs directly; there
  is no build step.
- **An AI engine** — one of:
  - **`claudey`** *(default)* — `claude -p` in a Docker container with
    bypass-permissions. Blast radius is the container's mount scope.
  - **`codey`** — Codex (`codex exec`). Requires `codey` on PATH.
  - **`opencode`** — `opencode run`. Requires `opencode` on PATH.

  Each engine uses its own subscription auth; no metered API key. The default
  engine is `claudey`; override per-run with `--engine <kind>` or change the
  default with `sb config set defaultEngine <kind>`.
- **[Wrangler](https://developers.cloudflare.com/workers/wrangler/)**, logged in
  (`wrangler login`) — the Cloudflare Pages deploy.
- **[Astro](https://astro.build) toolchain** — pulled in per Site Version via
  `npm install`; nothing to install globally.

Optional:

- **A [Pexels](https://www.pexels.com/api/) API key** — enables tier-2 stock
  imagery during `generate`. Without it, `generate` falls back to a curated asset
  pack (see [Image sourcing](CONTEXT.md)).
- **The [GitHub CLI](https://cli.github.com/) (`gh`)**, authed — only for the
  opt-in `--github` / `sb push` flow. Deploy never needs it.
- **The `ui-ux-pro-max` skill** installed in whichever engine you're using —
  supplies design intelligence (palettes, fonts, a11y guardrails) at generate
  time ([ADR-0006](docs/adr/0006-design-intelligence-via-installed-skill.md)).

---

## Quick start

```bash
# 1. Clone and install
git clone <repo-url> site-builder
cd site-builder
bun install

# 2. Configure (interactive): pick the Root directory, point at the engine and
#    wrangler binaries, optionally paste a Pexels key.
bun run sb -- config

# 3. Check the environment is ready (engine + wrangler present and authed).
bun run sb -- config doctor

# 4. Build your first Client from its existing site → get a live link.
bun run sb -- build "Acme Plumbing" --url https://acmeplumbing.example
```

The last command walks the full pipeline — `init → ingest → synthesize →
generate → audit → deploy` — and prints the deployed `*.pages.dev` URL when it
finishes. On a real terminal it pauses for an optional [QA
session](CONTEXT.md) between context and generation; pass `--yes` to skip it.

> **`sb` vs `bun run sb --`.** Every example below uses a bare `sb`. The package
> isn't published, so either prefix commands with `bun run sb --` (e.g.
> `bun run sb -- build …`), or run `bun link` once to get a global `sb` on your
> PATH.

---

## How it works (in one breath)

A fixed **six-stage pipeline** across **two phases**
([ADR-0002](docs/adr/0002-two-phase-pipeline.md)):

| Phase | Stages | Scope | State file |
|---|---|---|---|
| **Context** | `init` → `ingest` → `synthesize` | Per Client; run once | `<client>/state.json` |
| **Generation** | `generate` → `audit` → `deploy` | Per Site Version | `<client>/sites/vN/state.json` |

- **`init`** — create the Client folder, register it. *(code)*
- **`ingest`** — crawl the existing site (HTML→Markdown, screenshots, asset
  download), extract documents, fold in `--notes`. *(code)*
- **`synthesize`** — classify/rename Assets, write the Client Profile + a "what we
  still need to know" Checklist. *(code + AI)*
- **`generate`** — derive a Design Brief, copy the [Kit](docs/kit.md), build the
  Astro site on top of it, source imagery, gate on `astro build`. *(code + AI)*
- **`audit`** — deterministic checks (axe-core + broken-link/asset) feed one AI
  review + fix pass, re-gated by `astro build`; then record the Lighthouse
  **Scorecard** as non-gating evidence. *(code + AI)*
- **`deploy`** — Wrangler Direct-Upload to Cloudflare Pages; record the
  `*.pages.dev` link. *(code)*

Resume happens **at stage boundaries** — each stage reads the prior stages'
on-disk artifacts, so a failed run picks up exactly where it stopped. For the
full picture, see **[docs/architecture.md](docs/architecture.md)**; for the
domain vocabulary, **[CONTEXT.md](CONTEXT.md)**.

---

## CLI reference

> Run a command with no args, `help`, or `-h` for the built-in summary.

### `config` — tool setup

| Command | What it does |
|---|---|
| `sb config` | Interactive setup. Writes `~/.config/site-builder/config.json` (XDG-aware). |
| `sb config doctor` | Check the environment: engine, wrangler (present + authed), root, `gh`, Pexels key. Exit 1 if a **required** check fails. |
| `sb config get <key>` | Print one config value. |
| `sb config set <key> <value>` | Update one config value (re-validated). |
| `sb config path` | Print the config file path. |

Settable keys: `root`, `defaultEngine`, `engines.claudey.bin`,
`engines.claudey.models.best`, `engines.claudey.models.small`,
`engines.codey.bin`, `engines.codey.models.best`, `engines.codey.models.small`,
`engines.opencode.bin`, `engines.opencode.models.best`,
`engines.opencode.models.small`, `wranglerBin`, `ghBin`, `pexelsApiKey`,
`viewports.desktop`, `viewports.mobile`, `pageCap`.

### `build` — the smart verb

```
sb build <client> [inputs] [generate flags] [continue flags]
```

Creates a Client and runs the full pipeline, or **smartly continues** an existing
one. It reads on-disk state and picks the least work needed
([ADR-0008](docs/adr/0008-smart-build-and-continuation.md)):

| Client exists? | Run incomplete? | New Inputs / `--refresh`? | Action |
|---|---|---|---|
| no | — | — | **new** — create + run the full pipeline → `v1` |
| yes | — | yes | **refresh** — re-run Context from `ingest`, then a new `vN+1` |
| yes | yes | no | **continue** — resume the latest version's first unfinished stage |
| yes | no | no | **noop** — nothing to do (points you at `variant`/`resume`) |

**Inputs** (at least one required for a *new* Client; an existing Client reuses
its recorded Inputs):

- `--url <url>` — existing site to crawl.
- `--docs <path>…` — PDF / Word / txt / Markdown files (repeatable or comma-separated).
- `--images <path>…` — local images (repeatable or comma-separated).
- `--notes <text>` — freeform notes.
- `--pages <n>` — crawl page cap for this run (default: config `pageCap`, 10).

> `--docs`/`--images` paths are stored verbatim and resolved relative to your
> current working directory whenever the run that ingests them executes — which
> may be a later `resume` or `--refresh` from a different directory. Prefer
> absolute paths so they survive those re-runs.

**Engine flag:**

- `--engine <kind>` — override the default engine for this run (`claudey`, `codey`, `opencode`).
  Defaults to the `defaultEngine` config value. Not persisted; a later `resume` without
  `--engine` uses `defaultEngine`.

**Generation flags:**

- `--vibe <text>` — steer the Design Brief's **mood/feeling** (e.g. `--vibe "calm, trustworthy"`).
- `--style <text>` — steer the Design Brief's **visual aesthetic** (e.g. `--style "high-contrast, condensed type"`).
- `--yes` / `-y` — skip the interactive QA session (Unknowns become Guessed; existing Guessed fields remain).

> These three flags only feed the `generate` stage. On a **continue** whose first
> unfinished stage is already past `generate` (`audit` or `deploy`), they have no
> effect — passing them prints a warning rather than silently dropping them. The
> same holds for `sb resume`.

**Continue flags:**

- `--refresh` — force a context re-run + new Site Version with no new Inputs
  (re-crawl the same ones). Passing *any* new Input implies a refresh.
- `--github` — after a successful build, publish the Site Version's source to a
  new **private** GitHub repo.

### `variant` — another take

```
sb variant <client> [--engine <kind>] [--vibe <text>] [--style <text>] [--github] [--yes]
```

Forks a **new Site Version** from the existing Context-phase output — no
re-crawl, no re-synthesize. The verb for "try a darker look." Runs `generate →
audit → deploy` into a fresh `vN+1`.

### `resume` — finish a failed run

```
sb resume <client> [--engine <kind>] [--vibe <text>] [--style <text>] [--yes]
```

Strictly continues the latest run from its first unfinished stage. Clears that
stage's own outputs (clear-own-output) and keeps earlier artifacts (keep-prior).
Unlike `build`, it never forks or refreshes.

`--vibe`, `--style`, and `--yes` only feed the `generate` stage (the brief's
style hints and the QA gate). If the resume point is already past `generate`
(i.e. `audit` or `deploy`), they have no effect — passing them prints a warning
rather than silently dropping them.

### `push` — publish to GitHub (opt-in)

```
sb push <client> [--version <n>]
```

Runs `gh repo create <slug>-vN --private --source=… --push` for a Site Version's
git repo and records the remote. Orthogonal to deploy — a live link never depends
on it ([ADR-0004](docs/adr/0004-deploy-via-wrangler-direct-upload.md)). Defaults
to the latest version.

### CRM commands

| Command | What it does |
|---|---|
| `sb list` | One row per Client (name, version count, latest deploy link), newest first. |
| `sb show <client>` | A Client's editable CRM record + Site Version pointers. |
| `sb set <client> <field> <value>` | Set one scalar field: `name`, `contact.name`, `contact.email`, `contact.phone`, `notes`, `url`. |
| `sb edit <client>` | Open `client.json` in `$EDITOR` (re-validated on save) — the way to edit arrays (`socials`, `reviews`, `docs`, `images`). |
| `sb status <client>` | Per-stage pipeline state for both phases. |

CRM writes touch only `client.json`; they can never corrupt the `state.json` that
resume depends on (the [ADR-0003](docs/adr/0003-storage-and-state-model.md)
split).

---

## Workflows

**New client from an existing site:**

```bash
sb build "Acme Plumbing" --url https://acmeplumbing.example
```

**New client from documents + notes (no site yet):**

```bash
sb build "Bright Dental" \
  --docs ./brochure.pdf --docs ./services.docx \
  --images ./logo.png \
  --notes "Family practice, warm and reassuring tone, books via phone"
```

**Steer the look:**

```bash
sb build "Acme Plumbing" --url https://acme.example --vibe "bold, industrial" --style "high-contrast, condensed type"
```

**A second take on the same client (different Design Brief, same context):**

```bash
sb variant "Acme Plumbing" --vibe "calm, trustworthy, lots of whitespace"
```

**The client updated their site, or you have new material — rebuild a fresh
version:**

```bash
sb build "Acme Plumbing" --refresh                       # re-crawl recorded Inputs
sb build "Acme Plumbing" --docs ./new-menu.pdf           # new Input also triggers a refresh
```

**A run failed (rate limit, transient error) — finish it:**

```bash
sb status "Acme Plumbing"     # see where it stopped
sb resume "Acme Plumbing"     # continue from there
```

**Also push the source to GitHub:**

```bash
sb build "Acme Plumbing" --url https://acme.example --github
sb push "Acme Plumbing"        # or after the fact, latest version
```

**Manage the CRM:**

```bash
sb list
sb show "Acme Plumbing"
sb set "Acme Plumbing" contact.email owner@acme.example
sb edit "Acme Plumbing"        # for socials/reviews arrays
```

---

## On-disk layout

Everything for one Client lives under the configured **Root**, keyed by a slug of
the name ([ADR-0003](docs/adr/0003-storage-and-state-model.md)). The Root *is*
the registry — no central index file.

```
<root>/
└── acme-plumbing/
    ├── client.json          # CRM facts (editable: contact, inputs, notes, Site Version pointers)
    ├── state.json           # context-phase pipeline state (machine-managed)
    ├── logs/                # per-run logs
    ├── ingest/              # raw crawl + provided inputs
    ├── context/             # Client Profile (Markdown + JSON sidecar) + Checklist gaps
    └── sites/
        └── v1/
            ├── state.json   # generation-phase state
            ├── brief.md     # the Design Brief
            ├── audit/       # checks.json, audit.md, lighthouse.json (the Scorecard)
            └── …            # the Astro project (its own git repo)
```

`client.json` is yours to edit; `state.json` is the machine's — never hand-edit
it.

---

## Configuration

`sb config` writes `~/.config/site-builder/config.json` (honors
`XDG_CONFIG_HOME`). Defaults:

| Key | Default | Notes |
|---|---|---|
| `root` | *(required, prompted)* | Where Client folders live. |
| `defaultEngine` | `claudey` | Engine used when `--engine` is not passed. |
| `engines.claudey.bin` | `claudey` | Binary for the claudey engine. |
| `engines.claudey.models.best` | `claude-opus-4-8` | generate + audit + synthesize (best tier). |
| `engines.claudey.models.small` | `claude-sonnet-5` | assetClassification + Design Brief (small tier). |
| `engines.codey.bin` | `codey` | Binary for the codey engine. |
| `engines.codey.models.best` | `gpt-5.5` | generate + audit + synthesize. |
| `engines.codey.models.small` | `gpt-5.4-mini` | assetClassification + Design Brief. |
| `engines.opencode.bin` | `opencode` | Binary for the opencode engine. |
| `engines.opencode.models.best` | `openrouter/deepseek/deepseek-v4-pro` | generate + audit + synthesize. |
| `engines.opencode.models.small` | `openrouter/deepseek/deepseek-v4-flash` | assetClassification + Design Brief. |
| `wranglerBin` | `wrangler` | Cloudflare deploy. |
| `ghBin` | `gh` | Only for `--github` / `sb push`. |
| `pexelsApiKey` | *(unset)* | Enables tier-2 stock imagery. |
| `viewports.desktop` / `viewports.mobile` | `1440` / `390` | Screenshot Viewport Profiles. |
| `pageCap` | `10` | Default crawl cap; override per run with `--pages`. |

---

## Troubleshooting

**`Site Builder is not configured yet`** — run `sb config`.

**`config doctor` shows `✗ engine (claudey): not found on PATH`** — install the
`claudey` wrapper (or point the binary with `sb config set engines.claudey.bin <path>`).
Auth is delegated to each engine's wrapper; `doctor` only checks presence.

**`✗ wrangler auth: not authenticated`** — run `wrangler login`. Deploy can't
publish without it.

**`! pexels api key: not set`** — only a warning. `generate` uses the curated
fallback asset pack instead of stock imagery. Add a key with
`sb config set pexelsApiKey <key>` to enable Pexels.

**`! github cli … not found / not authenticated`** — only a warning, and only
matters if you use `--github` / `sb push`. Install `gh` and run `gh auth login`.

**A run stopped partway (rate limit, crash, Ctrl-C).** Nothing is lost — state is
on disk. `sb status <client>` shows the failed stage; `sb resume <client>`
continues from it. A bare `sb build <client>` also continues an incomplete latest
version.

**`astro build` failed during generate/audit.** That's the one hard gate
([ADR-0007](docs/adr/0007-lighthouse-as-evidence-not-gate.md)) — the stage fails
on purpose rather than deploy a broken site. Check `sites/vN/` and the run log
under `<client>/logs/`, then `sb resume`.

**A low Lighthouse score.** Recorded in the Scorecard
(`sites/vN/audit/lighthouse.json`), never blocking — Lighthouse is evidence, not
a gate. v1 does one review + one fix pass; deeper score-chasing is deferred (see
[roadmap.md](docs/roadmap.md)).

**`at least one Input is required for a new Client`** — a brand-new Client needs
at least one of `--url`, `--docs`, `--images`, `--notes`.

---

## For contributors

- **[AGENTS.md](AGENTS.md)** — the canonical guide for working in this repo
  (commands, architecture, conventions, testing posture).
- **[CONTEXT.md](CONTEXT.md)** — the ubiquitous language. Every domain term is
  defined here; match it exactly.
- **[docs/architecture.md](docs/architecture.md)** — how the layers, pipeline,
  engine, storage, and seams fit together.
- **[docs/kit.md](docs/kit.md)** — the curated Astro Kit that sets the quality
  floor.
- **[docs/adr/](docs/adr/)** — the binding architectural decisions.
- **[docs/roadmap.md](docs/roadmap.md)** — what's explicitly out of scope for v1.

```bash
bun test            # all tests
bun run lint        # biome check (lint + format)
bun run typecheck   # tsc --noEmit
```
