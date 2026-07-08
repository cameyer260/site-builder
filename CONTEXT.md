# Site Builder

A CLI tool that generates working prototype websites for prospective freelance clients from whatever information is available about their business, for use as a fast outreach mechanism. It orchestrates deterministic code (crawling, screenshots, deploys) and a configurable headless AI coding-agent CLI — the **Engine** — for the AI-heavy stages.

## Language

**Client**:
The company/business being built for — the CRM-level entity, and the unit the directory is keyed by. The "Client's name" is the company name. A human contact is not a separate entity; it is fields on the Client (`contact_name`, `contact_email`, etc.). Has a name, optional existing website URL, social links, reviews, and notes. Exists independently of whether a Site has been generated yet.
_Avoid_: customer, account, business, lead (the company is the Client, not a separate "Business")

**Site**:
The generated Astro website artifact produced for a Client. The thing that gets deployed and sent as an outreach link.
_Avoid_: project, page, app

**Site Version**:
A distinct generation attempt or variant of a Site, stored as `<root>/<client-name>/sites/v1`, `v2`, etc. The latest version directory is the active/current Site. Variants are for materially different takes ("try a darker look"); incremental refinements within one variant live in that version's git history instead.
_Avoid_: revision, draft

**Root**:
The single user-chosen directory under which every Client's folder lives (e.g. `~/clients`). Configured once on first use.
_Avoid_: workspace, base dir

**Input**:
Any source of business information attached to a Client, feeding `ingest`/`synthesize`: an existing-site URL (crawled), documents (PDF/Word/txt/Markdown), images, and freeform `--notes`. At least one Input is required to run a Client; none individually is.
_Avoid_: source, data, material

## Playwright (two distinct uses)

**Playwright script**:
The Playwright npm library driven by the tool's own Node code. First-class and core. Powers ingest (crawl, HTML→Markdown, screenshots, asset download, normalize) and is reused in audit for screenshots. The shared screenshot logic is one reusable component that takes Viewport Profiles and captures native-resolution, screen-by-screen segments per profile.
_Avoid_: scraper, browser tool

**Viewport Profile**:
A named browser size the screenshot component renders at — desktop (1440px) and mobile (390px) by default, both configurable. Every screenshotting step (ingest and audit) runs all profiles, so responsiveness is always captured.
_Avoid_: breakpoint, device

## Pipeline

The tool runs a fixed sequence of six stages across two phases. Resume happens at stage boundaries.

**Context phase** (stages `init`, `ingest`, `synthesize`):
Builds the Client-level context. Run once per Client; re-run only when the Client's inputs change (live site updated, or new documents/images provided). Skippable when context already exists.
_Avoid_: phase 1, profiling stage

**Generation phase** (stages `generate`, `audit`, `deploy`):
Produces one Site Version from the existing Context-phase output. Run once per variant. Reuses ingest + context without re-running them.
_Avoid_: phase 2, build phase

**`init`**:
Creates the Client's folder, registers the Client, and sets up its state/records. Pure code.

**`ingest`**:
Gathers raw material into the Client folder from every provided input source. If a URL is given, crawls the existing website (HTML→Markdown, native-resolution screen-by-screen screenshots, asset download). Also collects any provided documents (PDF, Word, txt, Markdown) and images. The website is one input source among several, never individually required — only one input overall is. Pure code, no AI.

**`synthesize`**:
Turns raw ingested material into structured context the next stage can build from: classifies and renames downloaded image Assets, reconciles them against required assets (using Fallback Assets where missing), and produces the structured context files plus a "what we still need to know" checklist. Code plus AI.
_Avoid_: context build, analyze

**`generate`**:
Builds the Astro Site from the synthesized context, guided by skills and prompt-engineering docs, on top of the Kit. Ends with an `astro build` compile gate. Code plus AI. Distinct from `astro build` (the npm static compile), which is never called "generate".
_Avoid_: build

**Kit**:
The hand-maintained, opinionated Astro + Tailwind starter copied into each new Site Version at the start of `generate`. Owns the quality floor — SEO/meta, accessibility, performance (Astro `<Image>`), responsiveness, design tokens, and component primitives. Sets the floor, not the look: its components are adaptable starting points, and per-Client visual identity comes from instruction to the Engine, never baked in. Explicit non-goal: making every Site look the same.
_Avoid_: template, boilerplate, theme

**Design Brief**:
A short, explicit statement of one Site Version's visual direction — palette, type pairing, style/mood, layout character, imagery style — stored at `sites/vN/.site-builder/brief.md`. Derived at the start of `generate` from the Client's industry, brand cues, and existing-site screenshots/logo (honoring extracted brand colors when present), and editable or steerable via `--vibe`/`--style`. It is the deliberate lever for per-Client distinctiveness. A new variant is the same Client context with a different Design Brief.

**`.site-builder/`**:
The one folder inside a Site Version holding pipeline-internal artifacts that aren't Site content — the Design Brief (`brief.md`/`brief.json`), the declared stock-photo slots (`images.json`), and the completion marker (`.generated`). Dot-prefixed (like `.github/`) so it reads as tool metadata rather than a mystery folder once the prototype evolves into the Client's production repo. Committed to the Site Version's git history like everything else — unlike `state.json`, which is gitignored as pure machine bookkeeping with no lasting value.
_Avoid_: generate/ (the old, confusingly app-code-like location)
_Avoid_: theme, style guide, moodboard

**`audit`**:
Runs against the locally built Site (`astro preview`), pre-deploy. An AI review (desktop + mobile screenshots for visual quality; built source read directly for content accuracy and leftover placeholders), informed by deterministic checks (axe-core accessibility, broken-link/asset check), drives one fix pass, re-gated by `astro build`. Lighthouse (via the `lighthouse` npm package) then measures the fixed Site to produce the **Scorecard**. Lighthouse is non-gating evidence — `astro build` is the only hard gate; a low score is recorded, never blocking. Produces a structured audit file in `sites/vN/audit/`. Review + fix in one stage; a multi-pass verify loop (and any score-threshold gating) is a deferred improvement.

**Scorecard**:
The persisted record of one Site Version's achieved Lighthouse scores — Performance, Accessibility, Best Practices, SEO — captured per Lighthouse form factor (its own mobile and desktop presets, distinct from a `Viewport Profile`) after the `audit` fix pass. Stored under `sites/vN/audit/` and surfaced to the client as evidence of quality, in place of any bare "perfect 100s" claim.
_Avoid_: report, evidence, results

**`deploy`**:
Publishes the built Site to Cloudflare Pages via Wrangler Direct Upload (`wrangler pages deploy`) and returns a shareable `*.pages.dev` URL. No GitHub repo is involved. Pure code.

## Engine

**Engine**:
The AI coding-agent CLI that runs the AI-heavy stages (`synthesize`, `generate`, `audit`) — one of three interchangeable, one-shot backends selected per run with `--engine`: **claudey** (the default), **codey**, and **opencode**. Each reads prior stages' on-disk artifacts (never a live session) and owns its own invocation dialect, Model tiers, and result parsing behind a common adapter. claudey is the design-quality default; the selection is per-run and is not persisted across resume.
_Avoid_: backend, provider, agent, "Claude" (the Engine may not be Claude)

**Model tier**:
The engine-agnostic two-level model assignment every Engine fills — **best** (judgment/creative/deep-research work: `generate`, `audit`, `synthesize`) and **small** (lightweight structured extraction: asset classification, Design Brief derivation). The stage→tier mapping is fixed in code; each Engine supplies its own model for each tier (e.g. claudey best=Opus/small=Sonnet, codey best=gpt-5.5/small=gpt-5.4-mini) and always runs at a fixed high reasoning effort (claudey/codey `xhigh`, opencode `max` variant), regardless of tier.
_Avoid_: model role, size, level

## Context & Profile

**Checklist**:
A fixed, tool-shipped template of the questions worth answering about any business to build a good site (company name, industry, mission, services, audience, tone, contact, hours, location, socials, differentiators, testimonials, CTAs, etc.). Same starting set for every Client in v1; per-client/per-industry customization is a deferred improvement.
_Avoid_: questionnaire, survey

**Client Profile**:
The filled-in answers to the Checklist for one Client, produced by `synthesize` and stored in `context/`. Authored as Markdown (AI-written, human-editable, consumed by `generate`) with a small JSON sidecar for the few machine-checkable facts (asset manifest, contact/deploy facts). Editing the Profile and re-running the Generation phase yields a new Site Version.
_Avoid_: dossier, brief

**Field status**:
The provenance flag every Profile answer carries: **Known** (from real inputs or user-provided), **Guessed** (AI extrapolation, always flagged for later review), or **Unknown** (unanswered). Generated Sites may rely on Guessed values to stay complete, but those remain flagged so they get verified/corrected later.
_Avoid_: confidence, certainty

**QA session**:
An optional interactive gate between the Context and Generation phases. Surfaces every Unknown and every Guessed Checklist item for the operator to answer or verify — answered items become Known (user-provided), skipped/cancelled Guessed items stay Guessed, and skipped Unknown items become Guessed, so a complete, deployable prototype can still be produced. Skipped entirely (non-interactive run) → all unknowns become Guessed.
_Avoid_: interview, wizard

## Assets

**Asset**:
A media file (chiefly an image) downloaded from the Client's existing site during ingest, classified by AI during synthesize and renamed to a canonical convention (e.g. a recognized logo).

**Fallback Asset**:
A tool-provided default (e.g. a generic logo) used in the generated Site when the corresponding required Asset was not found among the Client's downloaded Assets.

**Image sourcing**:
The three-tier rule for non-logo imagery during `generate`: (1) the Client's real captured Assets when good enough — code stages these into the Site before the Engine runs, so the Engine only decides whether/where to reference one, never locates or copies it; (2) **Pexels** stock fetched at generate time — the Engine declares each slot's intent and search keywords, code does the fetch/download and hands files to Astro `<Image>`; (3) the curated Fallback Asset pack for offline / no-API-key. Tier 2 needs a Pexels API key (managed by `sb config`).
_Avoid_: placeholder, media library

## Removal

**Remove**:
The operation that permanently erases a Client and all their data, or a single Site Version, and tears down the external resources created for them. Scoped whole-Client (`sb remove <client>`) or per–Site-Version (`sb remove <client> --version n`). The deliberate inverse of the create path (`generate`/`deploy`/`push`): it deletes the local files, the hosted Cloudflare deployment(s), and any GitHub repos, then drops the CRM pointer. Irreversible — a Site Version's local `sites/vN` git repo is often the only surviving copy of its history, so Remove always confirms first (retype the slug) unless `--yes`.
_Avoid_: delete, destroy, purge, wipe, rm (the operation is Remove; "delete" names only the underlying per-resource API call)

**Teardown**:
The external half of a Remove: deleting a Site Version's hosted Cloudflare Pages deployment (matched to its recorded `deployUrl`), or the whole per-Client Pages project when the Client — or the Client's last remaining Version — is removed; plus deleting each Site Version's GitHub repo. Best-effort and reported per resource: a Version with no recorded URL/remote skips that step **with a warning**, and a failed Teardown aborts the local deletion (so a live Site or repo is never silently orphaned) unless `--force`.
_Avoid_: cleanup, uninstall, unpublish

**Compaction**:
Keeping Site Version numbers gapless after a per-Version Remove: every surviving Version above the removed one shifts down by one (remove v3 of v2–v5 → v4 becomes v3, v5 becomes v4). A shift rewrites the number everywhere it lives — the `sites/vN` directory name, the generation `state.json` version, and the `SiteVersionRef` in `client.json` — and renames the Version's GitHub repo (`<slug>-vN`), re-recording the new remote. The Cloudflare deployment URL is immutable and not derived from the number, so it is left as-is. There are never holes in the `vN` sequence.
_Avoid_: renumber (the mechanism, not the term), reindex, resequence
