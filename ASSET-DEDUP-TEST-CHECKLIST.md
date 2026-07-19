# Asset-dedup smoke test — Litteken Plumbing

> **Temporary.** Delete this file before merging PR #4. It exists only to guide a
> one-off real prototype generation that verifies ADR-0016 (`dedupeCandidates`)
> and the four review fixes actually work end-to-end against a live WordPress
> site (https://littekenplumbing.com/).

## What we're proving

The synthesize stage should now collapse WordPress derivative image
multiplication (same original served at many registered sizes / theme crops /
cache-bust variants) down to one representative per original **before** the
vision-classification engine call — cutting that call's cost/turns without
changing what it decides. The four review fixes harden the grouping so it
doesn't silently mis-key on query strings or wrongly drop/merge real images.

---

## 0. Pre-flight

- [ ] On the right branch: `git rev-parse --abbrev-ref HEAD` → `feat/dedupe-asset-candidates`
- [ ] Env is healthy: `bun run sb -- config doctor` (engine, wrangler, gh, keys all OK)
- [ ] Note the data root for later inspection:
      `ROOT=$(bun run sb -- config get root); echo "$ROOT"`
- [ ] Client dir will be: `CLIENT="$ROOT/litteken-plumbing"` (slug of "Litteken Plumbing")
- [ ] If a stale `litteken-plumbing` already exists from a prior run and you want a
      clean crawl, remove it first: `bun run sb -- remove "Litteken Plumbing" --yes`

## 1. Run the prototype generation

```bash
bun run sb -- build "Litteken Plumbing" --url https://littekenplumbing.com/
```

- [ ] (optional) cap the crawl while smoke-testing: add `--pages 25`
- [ ] (optional) skip the interactive generate QA gate: add `--yes`
- [ ] Tee the output so you can grep it afterward:
      `... build "Litteken Plumbing" --url https://littekenplumbing.com/ 2>&1 | tee /tmp/litteken-run.log`

## 2. Watch the live log for the dedup signal

During the **synthesize** stage, you should see the new line (only prints when it
actually collapsed something):

```
synthesize: deduped <N> candidate asset(s) → <M> (<N-M> duplicate/derivative/undersized)
synthesize: classifying <M> captured asset(s)
```

- [ ] The `deduped … → …` line appears, and **M is meaningfully smaller than N**
      (WordPress sites typically shed a large fraction — the ADR saw 117 → a few dozen)
- [ ] The classification call then **completes** — no `--max-budget-usd` abort,
      no "engine succeeded but wrote nothing", no EPIPE/parse failure
- [ ] You do **not** see `synthesize: no captured assets to classify`
      (that would mean everything got dropped — a regression)

## 3. Inspect the artifacts

```bash
# how many image candidates were actually captured on disk (input to dedup)
find "$CLIENT/ingest" -type f \( -iname '*.png' -o -iname '*.jpg' -o -iname '*.jpeg' \
  -o -iname '*.gif' -o -iname '*.webp' -o -iname '*.svg' -o -iname '*.ico' \) | wc -l

# what classification kept (the canonical asset set)
ls -la "$CLIENT/context/assets/"
cat "$CLIENT/context/assets.json" | jq '.assets | length, (.[] | {source, role, keep})'
```

- [ ] The captured-count roughly matches the `N` in the log; kept set is the smaller `M`-ish set
- [ ] A **logo** asset is present (role `logo`, `keep: true`) — the required asset survived
- [ ] Spot-check `assets.json` `source` paths: they should be clean on-disk filenames
      (e.g. `…/photo-768x512.jpg`), **not** mangled with `?ver=`/`?resize=` query strings
      — this is fix #1 (key off `absPath`, strip query/fragment)
- [ ] Eyeball `context/assets/`: no obvious real, distinct photos are missing, and no
      duplicate crops of the same original slipped through in large numbers

## 4. Fix-by-fix sanity (map symptoms → fixes)

| Fix | What to confirm on this run |
|-----|-----------------------------|
| #1 basename off `absPath` (+ strip query) | Derivatives from query-string CDN/cache-bust URLs still collapsed; `source` paths clean |
| #2 byte-only size floor | No large, real content image got dropped just because its filename had a small `-WxH` token; only genuinely tiny (<~1.5KB) rasters gone |
| #3 hash needs letters+digits | A file like `name-<20+char mixed hash>.ext` folded into its bare original, but a long all-letters slug did **not** get merged away |
| #4 anchored dimension token | No distinct image whose name merely *contains* an `NxN` fragment (e.g. `-3x5-`) got wrongly merged into a shorter sibling |

(#3/#4 are rare in the wild — mainly confirm nothing real went missing in `context/assets/`.)

## 5. End-to-end still green

- [ ] Generate → audit → deploy completes; you get a working prototype URL
- [ ] `bun run sb -- status "Litteken Plumbing"` shows the pipeline finished
- [ ] Open the deployed site: logo + imagery render correctly (nothing broken by a dropped asset)

## 6. Success criteria (all must hold)

1. Dedup line printed with a real reduction (`M < N`).
2. Classification completed cleanly (no budget/timeout/parse abort).
3. Logo present; no real distinct imagery missing from `context/assets/`.
4. `assets.json` sources are clean on-disk names, not query-string-mangled.
5. Prototype builds, deploys, and renders.

---

## Cleanup

Before accepting/merging PR #4:

```bash
git rm ASSET-DEDUP-TEST-CHECKLIST.md
git commit -m "chore: drop temporary asset-dedup test checklist"
```
