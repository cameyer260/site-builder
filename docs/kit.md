# The Kit

The **Kit** (`kit/`) is the hand-maintained, opinionated Astro 6 + Tailwind v4
starter that `generate` copies into every new Site Version
([ADR-0005](adr/0005-curated-kit-sets-the-floor.md)). This doc is the
maintainer's view — why it exists, how `generate` uses it, and how to improve it
without breaking the contract. The instructions the *engine* reads while building
on top of it live in **[`kit/CLAUDE.md`](../kit/CLAUDE.md)**; read that before
touching the Kit's internals.

## What the Kit is for

The Kit sets the **quality floor**, not the look:

- **Floor it owns** — SEO/meta, semantic landmarks + a11y baseline, performance
  via `astro:assets` (`<Image>`), responsiveness, a sitemap + `robots.txt`,
  design tokens, and component primitives. Every Site inherits these for free, so
  improving the Kit raises the floor for *every* Site at once.
- **What it deliberately does *not* own** — the visual identity. Per-Client look
  comes from the **Design Brief** and the engine's build instruction, never baked
  into the Kit. Its explicit non-goal is making every Site look the same.

Design intelligence (palettes, font pairings, a11y guardrails) is supplied at
generate time by the installed `ui-ux-pro-max` skill
([ADR-0006](adr/0006-design-intelligence-via-installed-skill.md)), so the Kit
stays a clean, re-themeable substrate rather than a library of canned themes.

This is a true Astro project with its own `package.json`, `CLAUDE.md`, and git
ignore — develop it standalone (`cd kit && npm install && npm run dev`).

## How `generate` uses it

1. `generate` derives the **Design Brief** (`sites/vN/.site-builder/brief.md`)
   from the Client's industry, brand cues, and existing-site screenshots/logo,
   steerable with `--vibe`/`--style`. `.site-builder/` holds this and the
   declared stock-photo manifest — pipeline-internal artifacts, not Site
   content.
2. It copies `kit/` into `sites/vN/` and `git init`s that directory — from here
   on, the Site Version is its own repo and the Kit copy is independent of the
   source Kit.
3. The engine builds on top of the copy: rewrites `src/data/site.ts` with the
   Client Profile facts, re-themes by overriding `@theme` tokens in `global.css`,
   adapts/adds/removes pages and components per the Profile, and wires in sourced
   imagery.
4. `astro build` is the **compile gate** — generation fails rather than emit a
   site that doesn't build.

The Kit is therefore a *starting point the engine edits*, not a frozen template.

## Layout

See [`kit/CLAUDE.md`](../kit/CLAUDE.md) for the authoritative, file-by-file
breakdown. In short:

- `src/styles/theme.css` — the design system: `oklch` brand/accent/ink ramps,
  fonts, radii, shadows, animation tokens, and custom utilities. **Don't edit
  tokens here** — they're overridden per-client in `global.css`.
- `src/styles/global.css` — imports `theme.css`; the home for per-client `@theme`
  overrides (swap the brand ramp to re-color the whole site).
- `src/layouts/BaseLayout.astro` — `<head>` SEO/meta, fonts, nav, footer, the
  scroll-reveal observer, JSON-LD.
- `src/components/*.astro` — 13 prop-driven primitives (`Navigation`, `Footer`,
  `Hero`, `SectionHeading`, `ServiceCard`, `TestimonialCard`, `FAQ`, `CTA`,
  `ContactForm`, `BusinessHours`, `MapEmbed`, `Button`, `LocalBusinessSchema`).
- `src/pages/` — `index`, `about`, `services`, `contact`, plus `robots.txt.ts`.
- `src/data/site.ts` — the single source of business facts; the first file the
  engine rewrites per client.
- `src/assets/` — `logo.png`, `hero.png`, `team.png`, re-exported via `index.ts`,
  optimized through `astro:assets`. Replaced with client imagery when available.
- `@/*` import alias → `src/*`.

## Maintaining the Kit

The Kit is the highest-leverage code in the repo: a fix here ships to every future
Site. When changing it, preserve the contract the engine and the
[audit](adr/0007-lighthouse-as-evidence-not-gate.md) stage rely on:

- **Keep it building and type-checking.** `npm run build` and `npm run check`
  must stay green; `astro build` is the generation gate.
- **Preserve the a11y/SEO floor.** One `header`/`main`/`footer`, the visible skip
  link, title/description/canonical, Open Graph + Twitter tags, the `og:image`
  fallback, favicon, JSON-LD, visible focus states, and the reduced-motion rules
  / `motion-safe:` prefixes. axe-core runs against the output in audit.
- **Keep tokens overridable.** Re-theming must stay a `global.css` `@theme`
  override — don't hardcode brand colors into components, or per-client theming
  breaks.
- **Stay re-themeable, not pre-styled.** Add primitives and structure, not a fixed
  aesthetic. If you find yourself encoding "the look," that belongs in the Design
  Brief path, not the Kit.
- **Keep it light.** No heavy client-side JS unless an interaction requires it;
  performance is part of the floor.

After any change, the acceptance bar is the Phase 4 milestone: the Kit builds
clean and scores well on Lighthouse with placeholder content.
