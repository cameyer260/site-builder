# Lighthouse is recorded evidence (the Scorecard), not a quality gate

`audit` runs Lighthouse to produce the **Scorecard** — the achieved Performance,
Accessibility, Best Practices, and SEO scores for a Site Version, per Lighthouse
form factor (mobile + desktop). Lighthouse runs **once per form factor, after**
the single AI review + fix pass, so the Scorecard reflects the Site that actually
ships. It is **non-gating**: a low score is persisted as
`sites/vN/.site-builder/lighthouse.json` and surfaced to the client as evidence,
never failing the stage or blocking deploy. `astro build` remains the only hard
gate.

The deterministic checks, per-Profile screenshots, and the AI's findings file are
stage-internal fix-drivers — built under a transient `sites/vN/audit/` working
dir and **deleted after the re-gate**. Only the Scorecard (`lighthouse.json`,
under `.site-builder/` with the rest of the pipeline metadata) persists into the
Site Version's git history and the client-facing repo; the working artifacts do
not.

**Why not gate / loop.** The obvious design (and one an AI chat proposed) is a
convergence loop — median-of-N Lighthouse runs → `audit → fix → re-audit` for
3–4 iterations → gate on thresholds (A11y/BP/SEO = 100, Perf ≥ 95) → notify on
non-convergence. We deliberately did **not** build that for v1:

- This tool ships **outreach prototypes**, not final deliverables. A
  near-perfect score (the Kit already starts at a clean Lighthouse profile) plus
  honest evidence is enough to win the conversation; the loop's extra `claude -p`
  passes inflate run time and burn subscription usage on every build.
- Lighthouse Performance is non-deterministic (throttling-sim noise swings several
  points run-to-run) and real client content (hero images, fonts, embeds) regresses
  perf after the Kit was proven clean. Optimizing the AI against one noisy snapshot,
  or gating on exactly-100 perf, makes the loop flap without reliably converging.
- A11y / Best Practices / SEO are rule-based and stable — the Kit floor (ADR-0005)
  plus axe-core feeding the single fix pass carries them; a gate adds little.

The client promise is therefore **process + evidence** (attach the Scorecard,
e.g. 96/100/100/100), never a bare "perfect 100s" claim — lab scores aren't field
data, and a later pixel/widget/hero swap can tank perf anyway. The
**multi-pass audit loop and any score-threshold gating remain deferred**
(`roadmap.md`); perfecting scores belongs to paid production builds, not the
prototype tool.

## Consequences

- If the single fix pass *introduces* a regression, the post-fix Scorecard
  **records it but does not auto-fix it** — that is the deferred loop. axe-core
  driving the fix makes this unlikely for a11y; perf/SEO show up as a visible
  number for the developer to act on (re-run or hand-fix).
- Lighthouse needs a Chrome binary; the container has no system Chrome, so audit
  points `chrome-launcher` at the Playwright Chromium via `CHROME_PATH` with
  `--no-sandbox --headless=new` (non-root container).
