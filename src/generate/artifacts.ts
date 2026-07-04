import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ARTIFACTS_DIRNAME } from "../storage/layout.ts";

/**
 * `.site-builder/` (defined in `storage/layout.ts`, the single source of truth
 * for on-disk layout) — the one directory inside a Site Version that holds
 * pipeline-internal artifacts (the Design Brief, the declared stock-photo
 * slots, the completion marker) instead of scattering them at the project
 * root or under a confusingly-named `generate/` folder that reads like app
 * code. Dot-prefixed so it reads immediately as tool metadata (mirroring
 * `.github/`, `.vscode/`) rather than a mystery top-level folder once this
 * prototype evolves into the Client's production repo.
 */
export { ARTIFACTS_DIRNAME };

const README = `# .site-builder/

Pipeline-internal artifacts produced by the Site Builder tool during \`generate\`
— not part of the deployed website, and never imported by the Astro app:

- \`brief.md\` / \`brief.json\` — the Design Brief (palette, fonts, style/mood)
  chosen for this Site Version.
- \`images.json\` — the stock-photo slots declared during the build, and the
  search queries used to fill them.
- \`.generated\` — the pipeline's completion marker; its presence means this
  Site Version built to completion and must never be regenerated over.

Safe to read for context on how this Site was generated; safe to ignore
otherwise.
`;

/** Absolute path to `.site-builder/` inside a Site Version dir. */
export function artifactsDir(versionDir: string): string {
  return join(versionDir, ARTIFACTS_DIRNAME);
}

/** Creates `.site-builder/` with its README, ready for `generate` to write into. */
export function ensureArtifactsDir(versionDir: string): string {
  const dir = artifactsDir(versionDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "README.md"), README);
  return dir;
}
