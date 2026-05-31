# Deploy via Wrangler Direct Upload; GitHub is independent and optional

The `deploy` stage publishes the built Astro Site to Cloudflare Pages using **Wrangler Direct Upload** (`wrangler pages deploy <dist> --project-name <name>`), not Cloudflare's Git integration.

**Why.** Cloudflare Pages offers two paths: (1) Git integration, where Cloudflare rebuilds on push to a connected GitHub/GitLab repo — but the initial connection is a dashboard OAuth step that cannot be scripted; and (2) Direct Upload via the Wrangler CLI, which uploads pre-built static output straight from the machine. Direct Upload is fully CLI-automatable, needs no dashboard step, and returns a shareable `*.pages.dev` URL immediately. It fits the tool's automated, subscription/CLI-auth philosophy (one-time `wrangler login`, persisted locally — mirroring `claude -p`).

**Consequence: deploy has no GitHub dependency.** A live link is produced purely from `astro build` + `wrangler pages deploy`. GitHub is therefore a fully optional, independent feature: every Site Version is `git init`'d locally during `generate`, and the opt-in `--github` flag (or `sb push`) creates a private remote and pushes via `gh repo create <name> --private --source=<dir> --push`, recording the remote URL in `client.json`. `--github` is a boolean, not a repo URL — the tool creates the repo, it does not link an existing one.

`sb config` verifies both `claude` and `wrangler` are authenticated.
