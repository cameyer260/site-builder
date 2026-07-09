# Models are chosen by capability role, not a single small/best tier

ADR-0010 gave each Engine a two-tier model abstraction — `best` (generate/audit/synthesize) and `small` (asset classification / Design Brief) — on one axis: intelligence. That axis is incomplete. The pipeline's engine calls also differ on **modality**: some must *look at pixels* (classify captured images, extract brand colors from the logo, review screenshots) and some are pure text (build the site from the Brief, synthesize the profile from Markdown). For claudey and codey this never mattered — every Claude and GPT model is multimodal, so vision is free and only intelligence varies. It matters acutely for **opencode over OpenRouter**, where the operator pays per token and picks à-la-carte models, many of which are **text-only**.

The failure that forced this: with the shipped opencode defaults, `assetClassification` (the `small` tier) resolved to `openrouter/deepseek/deepseek-v4-flash` — a text-only model — while its prompt says "visually inspect each of these image files." opencode reproducibly ran ~60s, wrote a filename-guessed `assets.json`, then crashed non-zero at teardown, and the stage fell back to a blank placeholder logo even though a real captured logo was on disk. The `small`/`best` tiers could not express "this call needs vision" independently of "this call needs intelligence," so there was no way to keep the cheap vision model on the vision call and a cheap *text* model on the build.

## Decision

**Every model-consuming call maps to one of four capability roles, on two axes (modality × intelligence):**

- `classify` — **cheap vision**: asset classification **and the Design Brief** (the Brief opens the logo + existing-site screenshots, so it is *not* a text-only call — ADR-0010 mis-tiered it as plain `small`).
- `code` — **text**: the Site build. It works entirely from the text Brief/Profile plus asset paths and their classified descriptions and never opens an image, so a strong, cheap text coder suffices — and it is the highest-token-volume call, where a cheap model saves the most.
- `reason` — **smart text**: profile synthesis, deep text research over the crawl.
- `audit` — **smart vision**: the review inspects per-page screenshots for visual quality.

The stage→role table is fixed **in code** (`engine/tiers.ts`, `STAGE_ROLE`), like ADR-0010's stage→tier table, so it cannot drift into config.

**The two base tiers stay; roles resolve through them with an optional per-role override.** `EngineProfile` keeps `models: { best, small }` and gains `modelRoles: { classify?, code?, reason?, audit? }`. Resolution (`resolveModel`) is: a per-role override when set, else the role's base tier (`ROLE_TIER`: `classify → small`, the other three `→ best`). Unknown stage names fall back to `best`, unchanged from ADR-0010.

**This lets multimodal and à-la-carte engines share one mechanism.** claudey and codey set **no** overrides — their `{best, small}` are unchanged from ADR-0010, and every role collapses onto them exactly as before (classify → sonnet/mini, the rest → opus/gpt-5.5). opencode sets its **base tiers to vision models** (so `classify` and `audit` are covered by default) and **overrides only the text roles** with cheap text models. The shipped opencode defaults become:

- `small` = `google/gemini-3-flash-preview` (cheap vision) → classify
- `best` = `google/gemini-3-pro-preview` (smart vision) → audit
- `modelRoles.code` = `z-ai/glm-5.2` (strong cheap coder) → generate
- `modelRoles.reason` = `deepseek/deepseek-v4-pro` (cheap text) → synthesize

Four distinct models, each matched to what its call actually needs, with the one genuinely pricey model (`audit`) confined to a single bounded call per Version.

## Consequences

- The shipped opencode config no longer sends a vision prompt to a text-only model — the concrete bug that motivated this ADR is closed structurally, not just by swapping one id.
- `generate` (the token-heavy build) rides a cheap coder while vision spend is reserved for the three calls that inspect pixels — the intended cost shape for a pay-per-token engine.
- claudey/codey behavior is byte-identical to ADR-0010; only the *description* of how their model is chosen changed. Existing `config.json` files keep loading — `modelRoles` defaults to `{}` (Zod), so an older config simply has no overrides and behaves as the pre-change two-tier engine did.
- `modelRoles.<role>` is settable per engine via `sb config set engines.<kind>.modelRoles.<role>`, and carried across a re-run of interactive `sb config`.
- `generate` staying on a **text** model is a deliberate constraint: the pipeline front-loads all vision into `classify` (which images to keep, brand colors) and `audit` (visual QA), so by build time everything the coder needs is already text. A mis-captured asset is caught later by the vision `audit` pass, not by making the most expensive, highest-volume call multimodal.

## Considered and rejected

- **Just swap the opencode `small` model to a vision model.** Fixes asset classification but leaves `brief` (also vision, also `small`) and the text/vision split unaddressed, and still forces the text build onto whatever the `best` tier is. A point fix for a structural gap.
- **A uniform four-slot `models` map on every engine** (`textSmall`/`visionSmall`/`textLarge`/`visionLarge`). Cleaner in the abstract but makes claudey/codey carry two redundant slots each and churns their config for no benefit, since vision is free for them. The base-tier-plus-overrides shape keeps multimodal engines at two values and asks à-la-carte engines to specify only what differs.
- **Per-stage overrides keyed by stage name** instead of by role. Simpler resolver, but it re-couples config to the stage list and loses the self-documenting "this call needs vision" intent that a role name carries; a new vision stage keyed only by name could silently inherit a text model again.
- **Give `generate` a vision model too.** Rejected on cost: it is the highest-volume call, and the pipeline already resolves every visual decision it would need upstream in `classify`/`brief`.
