import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clientPaths,
  latestVersion,
  listClientDirs,
  nextVersion,
  slugify,
} from "../src/storage/layout.ts";

test("slugify produces filesystem-safe keys", () => {
  expect(slugify("Acme Co.")).toBe("acme-co");
  expect(slugify("Bob's Burgers!!")).toBe("bobs-burgers");
  expect(slugify("  Spaced   Out  ")).toBe("spaced-out");
});

test("clientPaths mirrors the ADR-0003 layout", () => {
  const p = clientPaths("/root", "Acme Co");
  expect(p.slug).toBe("acme-co");
  expect(p.dir).toBe("/root/acme-co");
  expect(p.clientJson).toBe("/root/acme-co/client.json");
  expect(p.state).toBe("/root/acme-co/state.json");
  expect(p.versionDir(2)).toBe("/root/acme-co/sites/v2");
  expect(p.versionState(2)).toBe("/root/acme-co/sites/v2/state.json");
});

test("version scanning", () => {
  const root = mkdtempSync(join(tmpdir(), "sb-lay-"));
  const sites = join(root, "acme", "sites");
  expect(latestVersion(sites)).toBeNull();
  expect(nextVersion(sites)).toBe(1);
  mkdirSync(join(sites, "v1"), { recursive: true });
  mkdirSync(join(sites, "v3"), { recursive: true });
  expect(latestVersion(sites)).toBe(3);
  expect(nextVersion(sites)).toBe(4);
  rmSync(root, { recursive: true, force: true });
});

test("listClientDirs scans Root for client.json (Root-as-registry)", () => {
  const root = mkdtempSync(join(tmpdir(), "sb-reg-"));
  mkdirSync(join(root, "a"), { recursive: true });
  writeFileSync(join(root, "a", "client.json"), "{}");
  mkdirSync(join(root, "b"), { recursive: true }); // no client.json -> not a Client
  const found = listClientDirs(root);
  expect(found.length).toBe(1);
  expect(found[0]?.endsWith("/a")).toBe(true);
  rmSync(root, { recursive: true, force: true });
});
