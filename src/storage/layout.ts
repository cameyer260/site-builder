import { existsSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Canonical, filesystem-safe folder name for a Client. The directory is keyed
 * by this slug; the human-readable name is stored inside `client.json`.
 */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Resolved on-disk paths for one Client, mirroring ADR-0003's layout. State
 * lives at two levels: `state` (context phase) and `versionState(v)` (a Site
 * Version's generation phase).
 */
export interface ClientPaths {
  readonly name: string;
  readonly slug: string;
  readonly dir: string;
  readonly clientJson: string;
  readonly state: string;
  readonly ingest: string;
  readonly context: string;
  readonly logs: string;
  readonly sites: string;
  versionDir(version: number): string;
  versionState(version: number): string;
}

export function clientPaths(root: string, name: string): ClientPaths {
  const slug = slugify(name);
  if (!slug) {
    throw new Error(`client name "${name}" produces an empty slug`);
  }
  const dir = join(root, slug);
  const sites = join(dir, "sites");
  return {
    name,
    slug,
    dir,
    clientJson: join(dir, "client.json"),
    state: join(dir, "state.json"),
    ingest: join(dir, "ingest"),
    context: join(dir, "context"),
    logs: join(dir, "logs"),
    sites,
    versionDir: (v) => join(sites, `v${v}`),
    versionState: (v) => join(sites, `v${v}`, "state.json"),
  };
}

/** Whether a Client folder already exists at the slug for `name` under `root`. */
export function clientExists(root: string, name: string): boolean {
  return existsSync(clientPaths(root, name).clientJson);
}

/**
 * Root-as-registry scan: every immediate subdirectory of `root` that contains
 * a `client.json`. No central index file (ADR-0003).
 */
export function listClientDirs(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }
  const dirs: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const dir = join(root, entry.name);
    if (existsSync(join(dir, "client.json"))) {
      dirs.push(dir);
    }
  }
  return dirs;
}

/** Highest existing Site Version number under `sitesDir`, or null if none. */
export function latestVersion(sitesDir: string): number | null {
  if (!existsSync(sitesDir)) {
    return null;
  }
  let max = 0;
  for (const entry of readdirSync(sitesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const m = /^v(\d+)$/.exec(entry.name);
    if (m) {
      max = Math.max(max, Number(m[1]));
    }
  }
  return max > 0 ? max : null;
}

/** Next Site Version number to create under `sitesDir`. */
export function nextVersion(sitesDir: string): number {
  return (latestVersion(sitesDir) ?? 0) + 1;
}

/** True if `dir` exists and is a directory. */
export function isDir(dir: string): boolean {
  return existsSync(dir) && statSync(dir).isDirectory();
}

/**
 * `.site-builder/` — the one directory inside a Site Version holding
 * pipeline-internal artifacts (Design Brief, image-sourcing manifest, the
 * completion marker below) instead of scattering them at the project root
 * (`src/generate/artifacts.ts` owns creating it and writing into it).
 */
export const ARTIFACTS_DIRNAME = ".site-builder";

/**
 * Marker file `generate` writes into a Site Version's dir only after its
 * compile gate passes. Its presence means the version built to completion and
 * must never be regenerated over (ADR — Site Version overwrite protection).
 */
export const GENERATED_MARKER = ".generated";

/** Path to `version`'s completion marker under `paths`. */
export function versionMarkerPath(paths: ClientPaths, version: number): string {
  return join(paths.versionDir(version), ARTIFACTS_DIRNAME, GENERATED_MARKER);
}

/** Whether Site Version `version` under `paths` already built to completion. */
export function isVersionBuilt(paths: ClientPaths, version: number): boolean {
  return existsSync(versionMarkerPath(paths, version));
}

/** Deletes a Client's entire directory tree (`sb remove`, whole-Client scope, ADR-0012). */
export function removeClientDir(paths: ClientPaths): void {
  rmSync(paths.dir, { recursive: true, force: true });
}

/** Deletes one Site Version's directory (`sb remove --version n`, ADR-0012). */
export function removeVersionDir(paths: ClientPaths, version: number): void {
  rmSync(paths.versionDir(version), { recursive: true, force: true });
}

/**
 * Renames Site Version `from`'s directory into `to`'s slot (Removal's
 * Compaction, ADR-0012). Callers shift versions in ascending order so `to`'s
 * slot is always already vacated — by the removed Version's own deletion, or
 * by the previous iteration's rename — before this runs.
 */
export function renameVersionDir(paths: ClientPaths, from: number, to: number): void {
  renameSync(paths.versionDir(from), paths.versionDir(to));
}
