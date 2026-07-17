# `generate` builds on a curated Kit that sets the floor, not the look

*Amended by ADR-0015 (empty page skeletons; the look is composed per Client).*

`generate` does not hand Claude a blank Astro project, nor a rigid fixed template. It copies a hand-maintained, opinionated **Astro + Tailwind Kit** into `sites/vN/` and has `claude -p` build the Site on top of it.

**What the Kit owns (the floor — guaranteed every site):**
- SEO/meta, sitemap, structured data baseline
- Accessibility baseline
- Performance: Astro `<Image>` for build-time image optimization, sane defaults
- Responsive structure
- Design-token scaffolding (so color/spacing are themeable, not hardcoded)
- A library of component *primitives* (hero, services, testimonials, CTA, nav, footer) as adaptable starting points

**What Claude owns (tailoring — varies per Client):**
- Choosing/adapting/replacing components — primitives are starting points, not mandatory
- Visual identity: color, type feel, layout character, driven by per-Client instruction and brand cues
- Wiring real Profile content in

**Explicit non-goal:** sites that all look the same. The Kit raises the quality floor; it must not homogenize output. This is the deliberate middle between blank-scaffold (inconsistent quality, high token cost, reinvented boilerplate every run) and a fixed template (uniform, generic output).

**Compile gate:** after Claude finishes, `generate` runs `astro build`; a build failure fails the stage before any audit pass is spent on a broken Site.

Improving the Kit raises the floor for every future Site at once — it is the single highest-leverage maintenance surface in the tool.
