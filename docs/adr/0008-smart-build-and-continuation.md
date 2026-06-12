# Smart-build decision table and continuation operations

`sb build` is one verb that does the **least work needed to get a Client from its
Inputs to a deployed Site**. `resume` and `variant` stay distinct verbs so a
continuation is always explicit and never an accidental re-crawl or overwrite
(ADR-0002). This ADR pins down exactly what `build` decides, and how the CRM and
GitHub operations layer on.

## The smart-build decision table

`build` reads on-disk state and the latest Site Version, then picks one of four
actions. Let `refresh = --refresh || <new Inputs were passed>`.

| Client exists? | Run incomplete? | `refresh`? | Action | Targets |
|---|---|---|---|---|
| no | — | — | **new** — create the Client, run the full pipeline | `v1` |
| yes | — | yes | **refresh** — re-run the Context phase from `ingest`, then generate a new Site Version | `vN+1` |
| yes | yes | no | **continue** — resume from the first unfinished stage of the latest version | latest `vN` |
| yes | no | no | **noop** — nothing to do; point the user at `variant`/`resume`/`--refresh` | latest `vN` |

The rows are evaluated top-to-bottom; the first match wins. The implementation is
`smartBuild` in `src/pipeline/orchestrator.ts`; the command merges any re-passed
Inputs into `client.json` (so `ingest` re-reads them) before calling it.

### Why refresh makes a *new* Site Version, not an in-place rebuild

CONTEXT.md states: *"Editing the Profile and re-running the Generation phase
yields a new Site Version."* A refresh changes the Client's Inputs → the Profile
→ the build's basis, so it is exactly that case: a new `vN+1` is recorded and the
prior version (its tree, git history, and live link) is left intact. In-place
re-generation is reserved for **continue** (resuming a version that never
finished) — there the version is still being produced, so its git history holds
the increments (CONTEXT.md > Site Version: *"incremental refinements within one
variant live in that version's git history"*).

### Why `build` continues in place but `variant` always forks

`build` is "finish the job"; an unfinished latest version is the job, so it
resumes that version. `variant` is "give me another take from the same context";
it is the only verb that forks a new version *without* touching the Context
phase. Keeping them separate means `build` never surprises the user with an extra
version, and `variant` never re-crawls.

## CRM operations

The Root is the registry (ADR-0003), so the CRM commands are thin reads/writes
over `<slug>/client.json`:

- `list` — scan the Root, one row per Client (name, version count, latest link).
- `show` — print one Client's editable facts and Site Version pointers.
- `set` — write one scalar field (`name`, `contact.*`, `notes`, `url`),
  re-validated against the schema. Arrays are left to `edit`.
- `edit` — open `client.json` in `$EDITOR`, then re-validate on save.
- `status` — pipeline state (the machine-managed `state.json`), kept separate
  from the CRM facts above.

`set`/`edit` touch only `client.json`; they can never corrupt the `state.json`
that resume depends on (ADR-0003's split).

## GitHub is opt-in and orthogonal to deploy

Per ADR-0004 a live link comes purely from `astro build` + `wrangler pages
deploy`, so GitHub publishing is a separate, optional feature:

- Each Site Version is already its own git repo (seeded by `generate`).
- `build`/`variant --github`, or a standalone `sb push <client>`, runs
  `gh repo create <slug>-vN --private --source=<versionDir> --push` and records
  the remote on the Client's Site Version pointer (`recordSiteVersion`, never a
  stage output → survives resume).
- `--github` *creates* a private repo; it never links an existing one.
- The gh CLI is a non-required environment check (`sb config doctor`): missing
  `gh` only warns, because nothing in the core promise depends on it.

The publish step is behind an injectable seam (`GitHubPublisher`), mirroring
`deploy`'s wrangler seam, so tests never shell out to `gh`.
