# Idiomatic functional TypeScript over literal OO-SOLID

The codebase is deliberately written as **small, single-purpose functions and
modules with dependencies injected as plain function values** (the `engine`,
`buildSite`, `inspectSite`, `runLighthouse`, `deploySite`, `GitHubPublisher`
seams; params-object stages that default the seam to the real impl). When the
intent of "clean up the code / make it SOLID" comes up, we honor SOLID's
*intent* — one responsibility per unit, dependency inversion via injected seams,
clear boundaries validated at the edges (zod) — but we do **not** translate it
into OO ceremony: no class hierarchies, interfaces-for-their-own-sake, DI
containers, or wrapper objects around what reads fine as a function. For an
`sb`-sized Bun/TS CLI that pays a readability tax (for humans and AI) without
buying anything, so a literal-SOLID rewrite is rejected.

## Consequences

- Cleanup passes are **DRY + consistency** refactors (shared helpers like
  `readJsonFile`, `ensureBuiltDist`, a single crawl walker), not re-architecture.
- Such passes are **strictly behavior-preserving**: the prompt strings
  (`src/*/prompts.ts` + appended system prompts), engine argv and per-stage model
  selection, CLI surface and user-facing messages, on-disk paths/filenames/layout,
  config keys, and external-command construction (wrangler/gh/git) are a frozen
  contract — refactor happens *behind* it, never through it. (The test suite pins
  artifact shape, not AI prose, so this contract is enforced by review/diff, not
  tests alone.)
- A future "make this SOLID/OO" request is answered by this ADR rather than
  re-litigated.
