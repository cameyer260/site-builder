# Site Builder Kit

This is the curated Astro 6 + Tailwind v4 starter copied into `sites/vN` during
the `generate` stage. Treat it as the quality floor, not a fixed visual template.
It builds clean with `npm run build` and type-checks with `npm run check`.

## Layout

- `src/styles/theme.css` — the design system: `oklch` brand/accent/ink color
  ramps, fonts, radii, shadows, animation tokens, keyframes, and the custom
  `bg-mesh-*`, `bg-dot-grid`, and `text-gradient-brand` utilities. Imports
  Tailwind. **Don't edit tokens here** — override them in `global.css`.
- `src/styles/global.css` — imports `theme.css`; put per-client `@theme` token
  overrides here (e.g. swap the brand ramp to re-color the whole site).
- `src/layouts/BaseLayout.astro` — `<head>` SEO/meta, fonts, nav, footer, the
  scroll-reveal observer, and the JSON-LD via `LocalBusinessSchema`.
- `src/components/*.astro` — 13 primitives: `Navigation`, `Footer`, `Hero`,
  `SectionHeading`, `ServiceCard`, `TestimonialCard`, `FAQ`, `CTA`,
  `ContactForm`, `BusinessHours`, `MapEmbed`, `Button`, `LocalBusinessSchema`.
  Each is self-contained and prop-driven.
- `src/pages/` — `index`, `about`, `services`, `contact`, plus `robots.txt.ts`.
- `src/data/site.ts` — the single source of business facts (name, contact,
  hours, nav, socials, footer groups). The first file to edit per client.
- `src/assets/` — `logo.png`, `hero.png`, `team.png`, re-exported from
  `index.ts`. Optimized via `astro:assets` at build.
- Imports use the `@/*` alias → `src/*` (configured in `tsconfig.json`).

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

- Replace `src/data/site.ts` with the Client Profile facts.
- Replace the images in `src/assets/` with client-specific captured, generated,
  or fetched imagery when available (keep the export names in `index.ts`).
- Re-theme by overriding `@theme` tokens in `global.css` first (the brand ramp
  drives nav, buttons, links, mesh gradients, and accents) before reaching for
  hardcoded colors.
- Adapt, remove, or add pages and component primitives as the Profile warrants.

## Guardrails

- Do not turn this into a generic landing page when the Profile supports a more
  specific service, product, or local-business site.
- Do not hide client facts behind vague marketing copy.
- Do not add heavy client-side JavaScript unless the interaction requires it.
- Do not ship broken links, placeholder contact details, or unreadable contrast.
