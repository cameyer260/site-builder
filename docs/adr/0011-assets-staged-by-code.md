# Captured Assets are staged into the Site Version by code, not copied by the Engine

`generate`'s build call used to be told where a Client's captured Assets
(CONTEXT.md "Asset") lived under `context/assets/` and asked to copy the ones
it used into `src/assets/`, wire them through `astro:assets`, and prefer them
over stock photography or a hand-drawn substitute. In production this
instruction was reliably ignored: three consecutive Site Versions for the same
Client (one on `claudey`, two on `opencode`) shipped with zero captured Assets
actually used, including one run with an explicit, itemized per-Asset
instruction added specifically to fix this. Across all three, the model
consistently executed the *declarative* stock-photography path (`images.json`
→ Pexels fetch, entirely code-driven after the call returns) but never the
*imperative* one asked of it for captured Assets: locate a binary file outside
the project, copy its bytes across a directory boundary, and wire it in.

## Decision

`generate` now stages every Profile Asset into `src/assets/captured/`
(`src/generate/assets.ts`), and swaps a captured favicon over the Kit's
placeholder, *before* the build engine call ever runs. Which Assets to keep
was already decided once, deterministically, back in `synthesize`
(`reconcileAssets`) — the build call has nothing left to decide but
*whether/where to reference* an already-staged file, the same shape of edit it
already performs reliably for stock photography (add an import, use it in a
component). The favicon swap goes one step further: there is no creative
judgment in "does the Client's own favicon replace a generic placeholder," so
code performs it unconditionally, with no Engine involvement at all.

This extends the owner split ADR-0005 draws between the Kit (owns the floor)
and the Engine (owns tailoring) with a third actor: deterministic pipeline
code owns *mechanical file placement* whenever the underlying decision was
already made elsewhere. `pexels.ts` already does this in the opposite temporal
direction — the Engine declares intent, code fetches and places the bytes
*after* the call returns, because the search query doesn't exist until the
Engine decides it. Captured Assets invert that: the "keep or discard" judgment
happened days earlier in `synthesize`, so there is nothing to wait for — the
files can be placed *before* the call, removing the cross-directory copy from
the Engine's task list entirely rather than hoping it executes reliably.

## Consequences

- `warnUnusedCapturedAssets` (best-effort, non-gating per ADR-0007's
  evidence-not-gate philosophy) now checks whether a staged Asset is
  *referenced* by source text, not whether its bytes exist anywhere in the
  built Site — once staging is unconditional, mere presence proves nothing
  about use.
- The build prompt no longer needs an absolute `context/` path for Assets;
  they live inside the project directory the Engine is already scoped to work
  in, so this no longer depends on a given Engine's file-access behavior
  outside its own cwd.
- `icon` is excluded from both the staging-for-the-Engine path and the usage
  check — it is fully handled by the mechanical favicon swap instead, which
  reports its own outcome.

## Considered and rejected

- **Strengthen the prompt further.** Already tried once (the commit this ADR
  follows added an explicit per-Asset list with a "prefer real over
  stock/hand-drawn" instruction) and still failed under the same conditions.
  Prompt-only fixes have no way to verify they worked short of the same
  after-the-fact evidence check this ADR still keeps.
- **Gate the build on captured-Asset usage.** Rejected for the same reason
  Lighthouse isn't a gate (ADR-0007): a real design reason to skip a captured
  Asset is legitimate, and non-determinism in *why* an Engine ignored an
  instruction shouldn't fail a Site that otherwise builds and looks right.
