#!/usr/bin/env bun
/**
 * Generates the real PDF and DOCX fixtures used by the doc-extraction tests.
 * Run once and commit the output; `pdf-lib`/`docx` are dev-only deps used only
 * here, so the test suite reads committed binaries rather than depending on them.
 *
 *   bun run scripts/make-doc-fixtures.ts
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Document, Packer, Paragraph } from "docx";
import { PDFDocument, StandardFonts } from "pdf-lib";

const FIXTURE_DIR = join(import.meta.dir, "..", "test", "fixtures");
export const FIXTURE_TEXT = "Acme Plumbing has served the Bay Area since 1998.";

const pdf = await PDFDocument.create();
const page = pdf.addPage([612, 792]);
const font = await pdf.embedFont(StandardFonts.Helvetica);
page.drawText(FIXTURE_TEXT, { x: 72, y: 700, size: 18, font });
await writeFile(join(FIXTURE_DIR, "sample.pdf"), await pdf.save());

const docx = new Document({ sections: [{ children: [new Paragraph(FIXTURE_TEXT)] }] });
await writeFile(join(FIXTURE_DIR, "sample.docx"), await Packer.toBuffer(docx));

console.log(`wrote sample.pdf and sample.docx to ${FIXTURE_DIR}`);
