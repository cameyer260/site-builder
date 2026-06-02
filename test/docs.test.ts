import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { docKind, extractDoc } from "../src/ingest/docs.ts";

const FIXTURES = join(import.meta.dir, "fixtures");

test("docKind maps extensions", () => {
  expect(docKind("a.pdf")).toBe("pdf");
  expect(docKind("a.docx")).toBe("docx");
  expect(docKind("a.txt")).toBe("txt");
  expect(docKind("a.md")).toBe("md");
  expect(docKind("a.rtf")).toBe("unknown");
});

test("extractDoc reads plain text and markdown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-docs-"));
  const txt = join(dir, "note.txt");
  writeFileSync(txt, "  plain content here  ");
  const md = join(dir, "readme.md");
  writeFileSync(md, "# Title\n\nbody");

  expect((await extractDoc(txt)).text).toBe("plain content here");
  const mdResult = await extractDoc(md);
  expect(mdResult.kind).toBe("md");
  expect(mdResult.text).toContain("# Title");
  rmSync(dir, { recursive: true, force: true });
});

test("extractDoc extracts text from a real PDF", async () => {
  const result = await extractDoc(join(FIXTURES, "sample.pdf"));
  expect(result.kind).toBe("pdf");
  expect(result.text).toContain("Acme Plumbing");
  expect(result.text).toContain("1998");
});

test("extractDoc extracts text from a real DOCX", async () => {
  const result = await extractDoc(join(FIXTURES, "sample.docx"));
  expect(result.kind).toBe("docx");
  expect(result.text).toContain("Acme Plumbing");
  expect(result.text).toContain("1998");
});
