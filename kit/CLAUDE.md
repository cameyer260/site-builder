# Site Builder Kit

This is the curated Astro 6 + Tailwind v4 starter copied into `sites/vN` during
the `generate` stage. Treat it as the quality floor, not a visual template —
`src/pages/*` ship as near-empty skeletons on purpose. It builds clean with
`npm run build` and type-checks with `npm run check`.

## Layout

- `src/styles/theme.css` — the design system: `oklch` brand/accent/ink color
  ramps, fonts, radii, shadows, and neutral entrance-animation tokens
  (`fade-*`, `scale-in`) with their keyframes. Imports Tailwind. It ships **no**
  signature/decorative presets (no `bg-mesh-*`, `bg-dot-grid`, or
  `text-gradient-brand`) — that look is composed per Client at build time, not
  baked in. Prefer overriding tokens in `global.css`; if the Brief's direction
  needs decorative effects, build them for this Site.
- `src/styles/global.css` — imports `theme.css`; put per-client `@theme` token
  overrides here (e.g. swap the brand ramp to re-color the whole site).
- `src/layouts/BaseLayout.astro` — `<head>` SEO/meta, fonts, the skip link, the
  scroll-reveal observer, the JSON-LD via `LocalBusinessSchema`, and the shared
  `Navigation`/`Footer`. The SEO/a11y floor (meta, `<header>`/`<main>`/`<footer>`
  landmarks, skip link) is final; the `Navigation`/`Footer` it renders are
  neutral skeletons you are expected to restyle (see below).
- `src/components/*.astro` — the primitive component library, all neutrally
  styled (structure, behavior, and a11y — deliberately not a signature look):
  `Navigation` and `Footer` (unstyled header/footer skeletons rendered by
  BaseLayout on every page — restyle/compose them per the Brief, incl.
  responsive/mobile nav), `Button`, `ContactForm` (accessible form), `FAQ`
  (accessible `<details>` accordion), `MapEmbed` (a Google Maps embed),
  `BusinessHours`, and `LocalBusinessSchema` (JSON-LD). Each is self-contained
  and prop-driven — a parts box to compose *and style* pages from, not a fixed
  look. Presentational cards/headings (`ServiceCard`, `TestimonialCard`,
  `SectionHeading`) are intentionally NOT shipped — compose your own so they fit
  the Brief; the old styled versions are in `examples/` for reference only.
- `src/pages/` — `index`, `about`, `services`, `contact`, plus `robots.txt.ts`.
  Each `.astro` page ships as a near-empty skeleton (a single `<h1>`, one line
  of copy, and a comment instructing composition) — the build call is expected
  to design and compose the actual page from the primitives above (and/or new
  components of its own) per the Design Brief, not fill in a pre-built layout.
- `src/data/site.ts` — the single source of business facts (name, contact,
  hours, nav, socials, footer groups). The first file to edit per client.
- `src/assets/` — `logo.png`, `hero.png`, `team.png`, re-exported from
  `index.ts`. Optimized via `astro:assets` at build.
- `src/assets/captured/` — the Client's own real Assets (logo, photos), already
  staged here by the pipeline before you run. Not part of the Kit template
  itself — reference the ones that fit from `index.ts` instead of the Kit's
  own `logo.png`/`hero.png`/`team.png` placeholders or fetched stock.
- `examples/` — reference-only snapshots of the Kit's previous finished
  template (the fully composed dark mesh-gradient hero, animated blobs, glass
  pills, the styled `Navigation`/`Footer`, and the styled `ServiceCard`/
  `TestimonialCard`/`SectionHeading`). Kept for maintainer inspiration;
  NOT copied into generated Site Versions, NOT built, and NOT type-checked
  (`tsconfig.json` excludes it). See `examples/README.md`. Never hand this
  directory to the build call as something to reproduce.
- Imports use the `@/*` alias → `src/*` (configured in `tsconfig.json`).

## Design Brief

Each Site Version's build call reads `.site-builder/brief.md` — the Design
Brief — a concrete visual direction (palette, type pairing, style/mood, layout
character, imagery) derived for THIS Client from its industry, audience, brand
voice, and brand cues. Honor it decisively; do not default to a single "clean
blue" look regardless of what the Brief asks for. Different Clients should end
up with visibly different Sites because their Briefs differ.

## What to preserve

- Keep Astro building clean (`npm run build`) and types passing (`npm run check`).
- Preserve semantic landmarks: one `header`, one `main`, one `footer`, and the
  visible skip link.
- Keep SEO basics in `BaseLayout.astro`: title, description, canonical URL, Open
  Graph + Twitter tags, the hero `og:image` fallback, favicon, and JSON-LD.
- Set the production domain in `astro.config.mjs` (`site`) — canonical URLs, the
  sitemap, and `robots.txt` all derive from it.
- Use `astro:assets` (`<Image>` / `getImage`) for local design imagery.
- Keep focus states visible, and do not remove the reduced-motion rules or the
  `motion-safe:` prefixes on animations.

## What to tailor

- Compose each page (`src/pages/*.astro`) from the primitive components above
  and/or new components of your own — choose the section set, order, hero
  treatment, and decorative language that fit this Client and the Design Brief.
  Compose distinctively; do not reproduce a uniform template across Clients.
- Replace `src/data/site.ts` with the Client Profile facts.
- Replace the images in `src/assets/` with the Client's real Assets from
  `src/assets/captured/` when available, falling back to fetched stock
  imagery otherwise (keep the export names in `index.ts`).
- Re-theme by overriding `@theme` tokens in `global.css` first (the brand ramp
  drives nav, buttons, links, and accents) before reaching for hardcoded
  colors. New tokens/utilities are fine when the Brief warrants them.
- Adapt, remove, or add pages and component primitives as the Profile warrants.

## Guardrails

- Do not turn this into a generic landing page when the Profile supports a more
  specific service, product, or local-business site.
- Do not hide client facts behind vague marketing copy.
- Do not add heavy client-side JavaScript unless the interaction requires it.
- Do not ship broken links, placeholder contact details, or unreadable contrast.
- Do not ship the skeleton pages as-is — every page must be actually composed.
