# Kit examples (reference only)

This directory holds a snapshot of the Kit's previous finished template — the
fully composed dark mesh-gradient hero, animated blobs, glass pills, the fixed
four-page layout, the styled `Navigation`/`Footer`, and the styled presentational
components (`ServiceCard`/`TestimonialCard`/`SectionHeading`) that the Kit
shipped before it was stripped down to functional primitives plus near-empty
page skeletons (see `docs/adr/0015-*.md`).

They are kept **for maintainer inspiration only**: a reference for what the
Kit's primitives are capable of composing into, and a source to borrow
patterns from when improving `src/components/*`.

**Not part of the shipped Kit:**
- NOT copied into generated Site Versions (`src/generate/kit.ts` skips this
  directory entirely).
- NOT built — excluded from `npm run build`'s page graph (they live outside
  `src/pages/`).
- NOT type-checked — `kit/tsconfig.json` excludes `examples/` from
  `astro check`.

Do not hand this directory to the generate Engine as an example to copy — the
whole point of the reframed prompt is that the model composes a look for each
Client from the Design Brief instead of reproducing this one.
