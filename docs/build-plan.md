# v1 Build Plan

Phased implementation order for Site Builder v1. Principle: **prove the riskiest unknowns first, build the pipeline in execution order, defer polish.** Each phase ends at a checkable milestone. Anything in [`roadmap.md`](./roadmap.md) is explicitly excluded.

> Prerequisite: `git init` the project itself (this directory is not yet a repo).

---

## Phase 0 — Foundations

The skeleton everything hangs on. No AI, no Playwright yet.

- Bun + TypeScript project, `sb` CLI entrypoint, command router, lint/format/test setup.
- **Config system:** `sb config` (interactive setup + `get`/`set`), `~/.config/site-builder/config.json`, doctor checks (`claudey`, `wrangler` present + authed), Pexels key, defaults (viewports, page cap, `--pages`, models).
- **Storage model:** `client.json` + `state.json` schemas, Root + directory-layout helpers, uniqueness guard, `<client>/logs/`.
- **Pipeline orchestrator skeleton:** stage interface, state transitions, resume logic (clear-own-output / keep-prior), failure recording. Wire `build` / `resume` / `status` against **stub stages**.

**Milestone:** `sb config` works; `sb build x` walks stub stages, records state, and `sb resume`/`sb status` behave correctly on a forced stub failure.

## Phase 1 — Prove the engine (highest-risk unknown)

De-risk the whole AI side before depending on it.

- A `claudey -p` runner module: spawn `claudey -p`, pass prompt, cwd scoping + `--add-dir`, per-stage model selection, skill invocation, Playwright MCP config (fallback), capture `stream-json`, detect success/failure, log.
- Validate it edits files + runs bash unattended in the container and we can reliably detect completion.

**Milestone:** a throwaway prompt makes `claudey -p` create/edit a file in a scoped dir and we parse a clean success/failure signal.

## Phase 2 — `ingest` (deterministic, easy to validate)

- Playwright crawl: sitemap-first → internal-link fallback, same-origin, page cap, HTML→Markdown.
- **Screenshot component** (Viewport Profiles desktop 1440 + mobile 390, screen-by-screen native segments) — built reusable; `audit` consumes it later.
- Asset download (`<img>` + `og:image` + favicons) + source map.
- Document extraction (`pdf-parse`, `mammoth`, txt/md) + `--notes`.
- Normalize into the `ingest/` layout.

**Milestone:** `sb build x --url … --docs … --notes …` produces a fully populated, inspectable `ingest/` folder.

## Phase 3 — `synthesize`

- Ship the fixed **Checklist** template.
- `claudey -p` call A: asset classification (vision) → rename + asset manifest.
- `claudey -p` call B: profile synthesis → `profile.md` + `profile.json` (field statuses) + `checklist.md` gaps.

**Milestone:** the full **Context phase** runs end-to-end and emits a Profile with Known/Unknown fields.

## Phase 4 — The Kit

Craftsmanship; can be built in parallel with 1–3, but gates `generate`.

- Curated Astro + Tailwind starter: base layout, SEO/meta, sitemap, a11y baseline, Astro `<Image>` perf, design tokens, component primitives, Kit `CLAUDE.md`.

**Milestone:** the Kit builds clean (`astro build`) and scores well on Lighthouse with placeholder content.

## Phase 5 — `generate` (+ QA session)

- **QA session** interactive gate (surfaces Unknowns; skip → Guessed).
- **Design Brief** derivation (`claudey -p` small call + brand-color extraction from logo).
- Copy Kit → `sites/vN`, `git init`.
- `claudey -p` build: orchestration `--append-system-prompt` + invoke `ui-ux-pro-max` skill + read Profile/Brief, `--add-dir context`.
- **Pexels** integration (AI picks search terms, code fetches/optimizes) + fallback pack.
- `astro build` compile gate.

**Milestone:** one command goes from Inputs → a real, locally-building, tailored Astro site in `sites/v1`.

## Phase 6 — `audit`

- `astro preview` server; reuse the screenshot component (desktop + mobile).
- Deterministic checks: `axe-core`, broken-link/asset check, `lighthouse`.
- `claudey -p` review → `audit/audit.md`; one fix pass; `astro build` re-gate.

**Milestone:** audit produces a real findings file and measurably improves the site in the fix pass.

## Phase 7 — `deploy`

- `wrangler pages project create` + `wrangler pages deploy`; capture `*.pages.dev` URL → `client.json`.

**Milestone:** **full happy path** — `sb build <name> --url …` → shareable live link. This is v1's core promise.

## Phase 8 — CRM, GitHub, smart-build

- `list` / `show` / `set` / `edit` / `status` commands.
- GitHub opt-in: `--github` / `sb push` via `gh repo create … --push`; record remote.
- Wire the full **smart-build decision table** + `variant` + `--refresh`.

**Milestone:** the CRM and all continuation operations (resume / variant / refresh) work as specified.

## Phase 9 — Documentation

- `README.md` (quick start, CLI reference, workflows, troubleshooting), `docs/architecture.md`, `docs/kit.md`. (`CONTEXT.md`, ADRs, this plan, and `roadmap.md` already exist.)

**Milestone:** a new user can go from clone → configured → first deployed link using only the README.

---

## Testing posture

- **Unit tests** for the deterministic core: config, state transitions/resume logic, crawl/MD parsing, doc extraction, decision table.
- **Integration/manual** for AI stages (synthesize/generate/audit) — assert on artifact shape + gates (valid JSON, `astro build` passes, audit file present), not exact AI prose.

## Critical path / parallelism

`0 → 1 → 2 → 3 → 5 → 6 → 7` is the critical path. **Phase 4 (Kit)** can run in parallel with 1–3. **Phase 8** can start once 7 lands. **Phase 9** trails throughout but is finalized last.
