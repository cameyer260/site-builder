# Roadmap — Optional Improvements (post-v1)

Everything here is **explicitly out of scope for v1**. It is the single home for deferrals decided during planning, plus ideas worth keeping. v1 ships the core pipeline working end-to-end first; these come after.

## Ingest & context

- **Social / business-page auto-fetch.** Pull data directly from Google Business, Facebook, and Instagram. Includes reviews/ratings (e.g. via the Google Places API) and fields like business hours from a Google Business profile. v1 only harvests socials/testimonials that already appear in the crawled website; no platform scraping.
- **Auto-resolve Unknown Profile fields by code.** Instead of leaving a Checklist item Unknown (or letting AI guess it), fetch it — e.g. business hours from Google Business — inside the same pipeline.
- **Per-client / per-industry custom Checklists.** v1 uses one fixed, tool-shipped Checklist template; later allow tailoring the question set.
- **Auto-detect a changed live site.** Store a content hash/etag from the last crawl and diff on a cheap re-fetch to decide whether the context phase needs re-running, instead of relying on `--refresh` / re-passed inputs.
- **Scanned-PDF OCR.** v1 extracts text from digital PDFs/Word docs by code; OCR for scanned/image PDFs is deferred.
- **Wider asset capture.** v1 downloads `<img>`, `og:image`, and favicons/touch-icons. Later: CSS background-images and icon-font glyphs.

## Design & generation

- **Mobile-first / additional viewport profiles** beyond the v1 desktop (1440) + mobile (390) defaults, if needed.
- **Self-contained design intelligence.** v1 depends on the installed `ui-ux-pro-max` skill at runtime (see ADR-0006). Migration path: vendor a curated subset of its palettes/fonts/styles data + a query script + color extraction into the tool, so `sb` no longer requires the skill to be present.

## Audit

- **Multi-pass audit loop.** v1 does one review + one fix pass. Later: repeat review→fix with a re-screenshot verification step until the site converges or a pass budget is hit.

## Operations & usage

- **CLI reference split.** Keep the full CLI reference in the README for v1; split to `docs/cli-reference.md` only if it grows unwieldy.
- **Pre-run usage feasibility check.** *(see detailed section below.)*

## Productization

- **Brand name for the outreach product.** The CLI stays `sb` / "Site Builder"; a brandable name for the client-facing outreach side is a later decision.

---

## Pre-run usage feasibility check (detailed)

**Goal:** never start a run that is highly unlikely to finish, because an aborted run leaves an unfinished product *and* wastes usage. Estimate up front whether there's enough Claude Code usage left to complete a run before starting it.

**How it would work:**

1. **Record usage per run.** Track Claude Code token/usage consumption for each pipeline run. Store the stats with the **Site Version (variant) record** — usage is tied to a generation, not to the Client. (Likely alongside `sites/vN/state.json`, or a dedicated usage file there.)
2. **Build statistics over history.** From past runs, compute the average usage plus a lower/upper bound and basic spread, so we have a distribution of "what a run typically costs."
3. **Check remaining usage at run start.** Read the developer's current Claude Code usage / remaining budget against rate limits.
4. **Estimate completion likelihood.** Compare remaining usage to the historical run-cost distribution and estimate whether another full run is possible without hitting rate limits — ideally as a **percentage chance of hitting the limit** mid-run.
5. **Warn, don't block.** If the run is likely to hit limits, prompt a warning (including the estimated %). The user can heed it (exit and run later) or bypass it (proceed, accepting the risk of hitting the limit mid-run).

**Why post-v1:** depends on having accumulated run-cost history and on a reliable way to read current Claude Code usage; neither exists until the core tool has been running for a while.
