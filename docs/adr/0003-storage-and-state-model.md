# Storage and state model: Root-as-registry, facts split from machine state

**No central registry file.** The Root directory of per-client folders *is* the registry. `sb list` and other CRM reads scan `<root>/*/client.json`. A separate central index would be a second source of truth that drifts and needs reindexing; scanning is instant at the scale this tool operates (tens–hundreds of clients) and can never be out of sync.

**CRM facts are split from machine-managed run state**, in separate files:
- `client.json` — human- and AI-editable CRM facts: name, contact fields, input sources, social links, reviews, notes, and pointers to Site Versions (deploy URL, repo path/remote). This is what `sb show` and `sb edit` operate on.
- `state.json` — machine-managed pipeline state (completed stages, last run status, errors, timestamps); never hand-edited.

The split ensures the AI-edit command and manual edits can never corrupt resume state, and the pipeline can never clobber the user's notes.

**State lives at two levels, mirroring the phase split:**
- `<client>/state.json` — Context-phase progress.
- `<client>/sites/vN/state.json` — Generation-phase progress for that version.

`sb resume` reads whichever level the failure occurred in.

Resulting layout:
```
<root>/
└── <client-name>/
    ├── client.json          ← CRM facts (editable)
    ├── state.json           ← context-phase state (machine)
    ├── ingest/              ← raw crawl + provided inputs
    ├── context/             ← Client Profile (MD + JSON sidecar), Checklist gaps
    └── sites/
        └── v1/
            ├── state.json   ← generation-phase state (machine)
            └── ...          ← Astro project (own git repo), audit/
```
