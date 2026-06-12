import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ClientInputs,
  ClientInputsSchema,
  mergeClientInputs,
  newClient,
  readClient,
  setClientField,
  writeClient,
} from "../src/storage/client.ts";
import { clientPaths, listClientDirs } from "../src/storage/layout.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sb-crm-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function register(name: string, inputs: Partial<ClientInputs> = {}) {
  const paths = clientPaths(root, name);
  mkdirSync(paths.dir, { recursive: true });
  writeClient(paths.clientJson, newClient(name, ClientInputsSchema.parse(inputs)));
  return paths;
}

test("mergeClientInputs overrides scalars and unions lists without dupes", () => {
  const paths = register("Acme", { url: "https://old.example", docs: ["a.pdf"], images: [] });
  const merged = mergeClientInputs(paths.clientJson, {
    url: "https://new.example",
    docs: ["a.pdf", "b.pdf"],
    images: ["logo.png"],
    notes: "fresh notes",
  });

  expect(merged.inputs.url).toBe("https://new.example");
  expect(merged.inputs.docs).toEqual(["a.pdf", "b.pdf"]);
  expect(merged.inputs.images).toEqual(["logo.png"]);
  expect(merged.inputs.notes).toBe("fresh notes");
});

test("mergeClientInputs with empty Inputs keeps the record (bare --refresh)", () => {
  const paths = register("Beta", { url: "https://keep.example", docs: ["keep.pdf"], images: [] });
  const merged = mergeClientInputs(paths.clientJson, { docs: [], images: [] });
  expect(merged.inputs.url).toBe("https://keep.example");
  expect(merged.inputs.docs).toEqual(["keep.pdf"]);
});

test("setClientField writes scalar fields and rejects unknown keys", () => {
  const paths = register("Gamma");
  setClientField(paths.clientJson, "contact.email", "owner@gamma.com");
  setClientField(paths.clientJson, "notes", "called back Tuesday");
  setClientField(paths.clientJson, "url", "https://gamma.example");

  const client = readClient(paths.clientJson);
  expect(client?.contact.email).toBe("owner@gamma.com");
  expect(client?.notes).toBe("called back Tuesday");
  expect(client?.inputs.url).toBe("https://gamma.example");

  expect(() => setClientField(paths.clientJson, "bogus", "x")).toThrow();
});

test("listClientDirs scans every registered Client under the Root", () => {
  register("One");
  register("Two");
  // a stray directory without client.json is ignored
  mkdirSync(join(root, "not-a-client"), { recursive: true });

  const dirs = listClientDirs(root).map((d) => d.split("/").at(-1));
  expect(dirs.sort()).toEqual(["one", "two"]);
});
