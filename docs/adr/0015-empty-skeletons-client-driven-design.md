# Kit ships primitives + empty page skeletons; the look is composed per Client

*Amends ADR-0005.*

## Context

ADR-0005 states the Kit's explicit non-goal is "sites that all look the same,"
but in practice every generated Site converged on the same look: the Kit
shipped a finished, signature-styled four-page composition (dark mesh-gradient
hero, animated blobs, glass pills, a fixed section order per page), and the
`generate` build prompt framed the task as "theme to the Brief" — recolor a
tokens file and swap text into an already-built layout. A model given a
finished template to "tailor" reliably keeps the template's structure and
decoration; only the color ramp and copy actually varied per Client.

## Decision

- The Kit's `src/pages/*.astro` are now near-empty skeletons: a single `<h1>`,
  one line of placeholder copy, and a comment instructing the build call to
  compose the page from the Kit's primitives (and/or new components) per the
  Design Brief. `BaseLayout.astro` keeps the SEO/a11y floor (meta, the
  `<header>`/`<main>`/`<footer>` landmarks, the skip link), but the
  `Navigation` and `Footer` it renders on every page were themselves reduced to
  neutral, unstyled skeletons (their polished versions moved to `kit/examples/`
  alongside `Hero`/`CTA`). As shared, every-page components, their signature
  styling — a glassy sticky navbar with gradient underlines, a dark footer with
  a glow blob — homogenized output as much as the page bodies did.
- The remaining `src/components/*` were split by role. The **functional**
  primitives (`Button`, `ContactForm`, `FAQ`'s `<details>` accordion, `MapEmbed`,
  `BusinessHours`, `LocalBusinessSchema`) are kept but neutralized — behavior and
  a11y (labels, focus states, reduced-motion) preserved, signature decoration
  (gradient accents, hover-glow, glass, shimmer) stripped. The purely
  **presentational** blocks (`ServiceCard`, `TestimonialCard`, `SectionHeading`)
  carried a look but no unique function, so they moved to `kit/examples/` too;
  the build call composes its own cards and headings per the Brief.
- The previous finished compositions (`index`/`about`/`services`/`contact`,
  plus the `Hero`/`CTA` components that gave them their signature look) are
  preserved verbatim under `kit/examples/` for maintainer reference. They are
  never copied into a Site Version (`src/generate/kit.ts`'s `SKIP_ENTRIES`),
  never built, and excluded from `astro check` (`kit/tsconfig.json`).
- `theme.css` ships only the neutral floor: color/font/radius/shadow tokens,
  base defaults, the a11y scroll-reveal, and generic entrance-fade animations.
  The signature decorative presets (`bg-mesh-*`, `bg-dot-grid`,
  `text-gradient-brand`, and the blob/float/glow/gradient/shimmer/marquee
  animations) were removed — a shared preset every Site could reach for is
  itself a homogenizer. Decorative effects a Client's direction calls for are
  composed for that Site at build time.
- The `generate` build prompt (`buildGeneratePrompt`) is reframed from
  "recolor a template" to "design and compose": the Kit's primitive
  components are named explicitly as a parts box, composition (section set,
  order, hero treatment, decoration) is called out as a first-class, required
  decision, and the prompt says outright not to reproduce a uniform template
  across Clients.
- The visual direction is derived **per Client**, not chosen from a preset. The
  Design Brief call (`deriveBrief` + `buildBriefPrompt`) reads the Client
  Profile — industry, audience, brand voice, extracted logo colors,
  existing-site screenshots — and commits to a specific direction that fits
  THIS business, explicitly warned off a generic "clean/modern/trustworthy"
  default. Distinctiveness is a product of real Client differences plus the
  model's own non-determinism — the tool does not manufacture variety.

## Considered and rejected

- **A deterministic "Style Archetype" rotated by Client + version.** An earlier
  cut of this change picked one of eight fixed visual "territories" by hashing
  the Client name and incrementing by Site Version number. Rejected: it
  decouples the design from the Client (an arbitrary hash — not the Profile
  findings — chose the look) and hardcodes variety into the tool instead of
  letting per-Client facts and the model's non-determinism produce it. The
  Site must be designed *for* the Client, and the model is not deterministic —
  that is where the variability should come from.
- **Deleting the old finished template outright.** Kept as `kit/examples/`
  instead — free maintainer reference, zero runtime cost since it's excluded
  from copy/build/check.

## Consequences

- The Kit no longer builds a plausible-looking Site "for free" out of the box
  — the AI build call must do real compositional work every run. This raises
  token cost and risk on that call slightly, offset by the Kit still owning
  SEO/a11y/performance/landmarks/tokens (ADR-0005's floor is untouched).
- Sites should now diverge by Client because their Profiles — and therefore
  their Briefs — differ, honoring ADR-0005's stated non-goal instead of
  contradicting it in practice. Materially different variants of the *same*
  Client come from operator steering (`--vibe`/`--style`), as before.
- `kit/examples/` is a second, unmaintained copy of Astro markup that will
  drift from the primitives it references (`Hero`/`CTA` no longer exist under
  `src/components/`, and it uses the removed decorative presets) — acceptable
  since it is explicitly reference-only, never compiled, and never shipped.
- Design intelligence still comes from the installed `ui-ux-pro-max` skill
  (ADR-0006); nothing in this change replaces the model's design judgment.
