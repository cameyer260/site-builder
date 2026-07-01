import type { IngestManifest } from "../ingest/manifest.ts";
import type { AssetCandidate } from "./assets.ts";
import { ASSET_ROLES } from "./assets.ts";
import { renderChecklistForPrompt } from "./checklist.ts";

/**
 * Prompts for the two `synthesize` engine calls. Each instructs the model to
 * write its result to a specific on-disk file (the stage then reads + validates
 * it), rather than returning prose — stages communicate through artifacts.
 */

/** Call A: vision classification of captured Assets → `context/assets.json`. */
export function buildAssetPrompt(input: {
  contextDir: string;
  candidates: AssetCandidate[];
}): string {
  const list = input.candidates.map((c) => `- ${c.absPath}`).join("\n");
  return [
    "You are classifying the images captured from a business's existing website,",
    "to assemble the asset set for a new marketing site.",
    "",
    "Open and visually inspect each of these image files:",
    list,
    "",
    `Classify each into exactly one role: ${ASSET_ROLES.join(", ")}.`,
    "Set `keep` to true only for images worth reusing on a polished marketing",
    "site (a real logo, strong hero/photography, genuine product/team shots).",
    "Set `keep` to false for tracking pixels, tiny spacers, decorative icons,",
    "duplicates, or anything low-value or unreadable. Choose at most ONE logo.",
    "Write a concise, descriptive `alt` for each kept image.",
    "",
    `Write your answer as JSON to the file ${input.contextDir}/assets.json with this shape:`,
    '{ "assets": [ { "source": "<the exact absolute path above>", "role": "<role>", "keep": true|false, "alt": "<alt text>" } ] }',
    "",
    "Include one entry per file above, echoing its path verbatim in `source`.",
    "Write ONLY that file. Do not print anything else.",
  ].join("\n");
}

function manifestSummary(manifest: IngestManifest): string {
  const lines: string[] = [];
  if (manifest.site) {
    lines.push(`- Existing site: ${manifest.site.baseUrl} (${manifest.site.pages.length} page(s))`);
    for (const page of manifest.site.pages) {
      lines.push(`    - ${page.title || page.slug} → ${page.markdownPath}`);
    }
  }
  for (const doc of manifest.docs) {
    if (doc.localPath) {
      lines.push(`- Document: ${doc.localPath} (${doc.kind})`);
    }
  }
  if (manifest.notes) {
    lines.push(`- Operator notes: ${manifest.notes}`);
  }
  return lines.join("\n") || "- (no inputs were ingested)";
}

/** Call B: profile synthesis → `context/profile.json` + `context/profile.md`. */
export function buildProfilePrompt(input: {
  ingestDir: string;
  contextDir: string;
  manifest: IngestManifest;
  clientName: string;
}): string {
  return [
    `You are a brand researcher building a Client Profile for "${input.clientName}",`,
    "to drive generation of a new marketing website. Work only from the ingested",
    "material — never invent facts.",
    "",
    `All source material is under: ${input.ingestDir}`,
    "You must read EVERY Markdown file listed in the index below. Do not skip any",
    "page, document, or notes file. Each Known field must be traceable to a source.",
    "Here is the index of what was ingested:",
    manifestSummary(input.manifest),
    "",
    "Fill in this Checklist. For every item, decide a Field status:",
    "- Known: directly supported by a specific Markdown file. Set `status` to Known",
    "  ONLY when you can cite the exact source. Set `source` to the page URL (for",
    "  crawled site pages) or the Markdown file path (for documents/notes) where",
    "  the answer appears. A field without a source must not be Known.",
    "- Guessed: a reasonable inference/extrapolation — set the value AND explain the",
    "  basis in `note` so it can be reviewed later. Never label a guess as Known.",
    "- Unknown: no basis in the material — set value to null.",
    "",
    "Checklist items:",
    renderChecklistForPrompt(),
    "",
    `Write two files into ${input.contextDir}:`,
    "",
    "1. profile.json — structured data with this exact shape:",
    "{",
    `  "client": "${input.clientName}",`,
    '  "fields": [ { "key": "<checklist key>", "label": "<label>", "value": <string, array of strings for lists, or null>, "status": "Known|Guessed|Unknown", "source": "<url-or-file-path-or-omit>", "note": "<optional>" } ],',
    '  "contact": { "email": "<optional>", "phone": "<optional>", "address": "<optional>" }',
    "}",
    "Include one `fields` entry for EVERY checklist key above, in order. Omit `source`",
    "for Guessed and Unknown fields; include it for every Known field.",
    "",
    "2. profile.md — a clear, human-readable Client Profile grouped by section,",
    "with each answer tagged by its status and, for Known values, the cited source,",
    "e.g. `**Industry** (Known, from http://example.com/about): …`.",
    "Lead with the company name and a short summary paragraph.",
    "",
    "Write ONLY those two files. Do not print anything else.",
  ].join("\n");
}
