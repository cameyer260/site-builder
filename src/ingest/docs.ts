import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import mammoth from "mammoth";
import { extractText, getDocumentProxy } from "unpdf";

/**
 * Document text extraction (CONTEXT.md > Input). v1 handles
 * digital PDF, Word (.docx), and plain text/Markdown by code — no AI, no OCR
 * (scanned-PDF OCR is deferred in the roadmap).
 *
 * Note: uses `unpdf` rather than the build plan's illustrative `pdf-parse`,
 * whose CJS debug block reads a hardcoded test file and breaks under Bun/ESM.
 * `unpdf` is a Bun-friendly pdf.js wrapper with no native dependencies.
 */
export type DocKind = "pdf" | "docx" | "txt" | "md" | "unknown";

export interface ExtractedDoc {
  source: string;
  kind: DocKind;
  text: string;
}

export function docKind(path: string): DocKind {
  switch (extname(path).toLowerCase()) {
    case ".pdf":
      return "pdf";
    case ".docx":
      return "docx";
    case ".txt":
      return "txt";
    case ".md":
    case ".markdown":
      return "md";
    default:
      return "unknown";
  }
}

export async function extractDoc(path: string): Promise<ExtractedDoc> {
  const kind = docKind(path);

  if (kind === "pdf") {
    const buffer = new Uint8Array(await readFile(path));
    const pdf = await getDocumentProxy(buffer);
    const { text } = await extractText(pdf, { mergePages: true });
    const merged = Array.isArray(text) ? text.join("\n\n") : text;
    return { source: path, kind, text: merged.trim() };
  }

  if (kind === "docx") {
    const { value } = await mammoth.extractRawText({ path });
    return { source: path, kind, text: value.trim() };
  }

  // txt / md / unknown: read as UTF-8 text
  const text = await readFile(path, "utf8");
  return { source: path, kind: kind === "unknown" ? "txt" : kind, text: text.trim() };
}
