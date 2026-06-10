import { spawnSync } from "node:child_process";

/**
 * Tiny git wrappers shared by the stages that snapshot a Site Version's tree
 * (`generate` seeds the Kit baseline + generated commit; `audit` snapshots its
 * fix pass). Each Site Version is its own repo so incremental refinements live
 * in that version's history (CONTEXT.md > Site Version). Best-effort: a missing
 * git or identity is reported as `false`, never thrown — version history is a
 * convenience, not a gate on producing a building Site.
 */

// Commit under an explicit identity so a missing global git config can't fail it.
const GIT_IDENT = ["-c", "user.name=Site Builder", "-c", "user.email=site-builder@localhost"];

function git(cwd: string, ...args: string[]): boolean {
  return spawnSync("git", args, { cwd, stdio: "ignore" }).status === 0;
}

/** `git init -q` in `cwd`. Returns false (without throwing) if git is unavailable. */
export function gitInit(cwd: string): boolean {
  return git(cwd, "init", "-q");
}

/**
 * Stages everything and commits it under the tool's identity. Returns false
 * (without throwing) when git is unavailable or there is nothing to commit.
 */
export function commitAll(cwd: string, message: string): boolean {
  return git(cwd, "add", "-A") && git(cwd, ...GIT_IDENT, "commit", "-q", "-m", message);
}
