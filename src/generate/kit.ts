import { spawnSync } from "node:child_process";
import { cpSync, existsSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { UserError } from "../util/errors.ts";
import type { Logger } from "../util/log.ts";

/**
 * Copying the curated **Kit** into a Site Version and seeding its git history
 * (build-plan Phase 5, ADR-0005). The Kit sets the quality floor; the AI build
 * then tailors the copy. Each Site Version is its own git repo so incremental
 * refinements live in that version's history (CONTEXT.md > Site Version).
 */

/** Build artifacts and local state never copied from the Kit into a Site. */
const SKIP_ENTRIES = new Set(["node_modules", ".astro", "dist", ".git", ".DS_Store", "state.json"]);

const SITE_GITIGNORE = `node_modules/
dist/
.astro/
`;

/** Absolute path to the bundled Kit at the tool root (`<root>/kit`). */
export function kitDir(): string {
  return fileURLToPath(new URL("../../kit", import.meta.url));
}

/**
 * Copies the Kit into `destDir`, skipping build artifacts, and writes a
 * `.gitignore`. The destination is assumed already cleared of everything but
 * its `state.json` (the orchestrator preserves that across resumes).
 */
export function copyKitInto(destDir: string, log: Logger): void {
  const src = kitDir();
  if (!existsSync(join(src, "package.json"))) {
    throw new UserError(
      `generate: Kit not found at ${src}`,
      "the bundled kit/ directory is missing from the install",
    );
  }
  cpSync(src, destDir, {
    recursive: true,
    filter: (from) => !SKIP_ENTRIES.has(basename(from)),
  });
  writeFileSync(join(destDir, ".gitignore"), SITE_GITIGNORE);
  log.step(`generate: copied Kit into ${basename(destDir)}`);
}

// Commit under an explicit identity so a missing global git config can't fail it.
const GIT_IDENT = ["-c", "user.name=Site Builder", "-c", "user.email=site-builder@localhost"];

function git(destDir: string, ...args: string[]): boolean {
  return spawnSync("git", args, { cwd: destDir, stdio: "ignore" }).status === 0;
}

/**
 * `git init` + a baseline commit of the freshly copied Kit, so the AI build's
 * edits are a reviewable diff. Best-effort: git problems (not installed, no
 * identity) are logged and swallowed — version history is a convenience, not a
 * gate on producing a building Site.
 */
export function gitInitBaseline(destDir: string, log: Logger): void {
  if (!git(destDir, "init", "-q")) {
    log.warn("generate: git init unavailable — skipping version history");
    return;
  }
  if (commitAll(destDir, "chore: kit baseline")) {
    log.step("generate: committed Kit baseline");
  } else {
    log.warn("generate: baseline commit skipped");
  }
}

/**
 * Stages everything and commits it under the tool's identity. Returns false
 * (without throwing) when git is unavailable or there is nothing to commit.
 */
export function commitAll(destDir: string, message: string): boolean {
  return git(destDir, "add", "-A") && git(destDir, ...GIT_IDENT, "commit", "-q", "-m", message);
}
