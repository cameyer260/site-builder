# Design intelligence comes from the installed `ui-ux-pro-max` skill, not vendored data

`generate` (and `audit`) obtain design intelligence — palettes, font pairings, style selection, and the a11y/performance/typography guardrails — by invoking the **`ui-ux-pro-max` skill already installed in the developer's Claude Code environment**, rather than vendoring a curated copy of its CSV data into this tool.

**Why.** The developer has the skill installed and intends to keep it. Depending on it directly avoids maintaining a parallel design dataset and is materially simpler to build. The alternative (vendoring a trimmed palettes/fonts/styles catalog + color-extraction so the tool is self-contained) was considered and rejected for v1 on simplicity grounds.

**Consequences.**
- The tool assumes `ui-ux-pro-max` (and its Python/Node script dependencies) is present on the machine running `sb`. This is an accepted, non-portable runtime dependency.
- With pluggable Engines (ADR-0010), the skill must be installed and invocable **by name in whichever harness the selected Engine runs in** — not only Claude Code, but also codey's (`~/.codex`) and opencode's skill systems. The prompts name the skill engine-agnostically; an Engine whose harness lacks it silently degrades to the model's own design sense.
- The tool's own `--append-system-prompt` is therefore thin: only tool-orchestration directives (use the Kit, honor the Design Brief + Client Profile, invoke `ui-ux-pro-max`, output constraints) — not re-derived design theory.
- Brand-color extraction from the captured logo can reuse the skill's `brand/extract-colors` approach.

**Migration path if it ever breaks or the tool is shared:** vendor a curated subset of the skill's data + a query script into the tool, flipping it self-contained. The `generate`/`audit` prompt layer is the only place that would change.
