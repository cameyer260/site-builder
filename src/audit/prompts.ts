/**
 * Prompts for the single `audit` engine call (CONTEXT.md > audit; ADR-0007). One
 * invocation both *reviews* the built Site — writing findings to `audit/audit.md`
 * — and applies **one** fix pass to the Site source. As elsewhere, the model
 * communicates by writing/editing files, not by returning prose, and design
 * intelligence comes from the `ui-ux-pro-max` skill (ADR-0006), not the prompt.
 */

/** Thin orchestration directives appended to the system prompt for the audit call. */
export const AUDIT_SYSTEM_PROMPT = [
  "You are the `audit` stage of the Site Builder pipeline.",
  "Review the already-built Site, then apply ONE fix pass in the same run.",
  "Preserve the Kit's quality floor (semantic landmarks, SEO/meta, focus states,",
  "reduced-motion rules); do not regress it while fixing.",
  "Use the `ui-ux-pro-max` skill for visual/accessibility judgment.",
  "Do NOT run npm, astro build, or astro dev — the pipeline runs the compile gate.",
  "Communicate only by writing audit/audit.md and editing the Site files; do not",
  "print explanations.",
].join(" ");

export interface AuditPromptInput {
  clientName: string;
  /** Deterministic findings the inspection already produced (axe + broken refs). */
  checksJsonPath: string;
  /** Where the per-Profile screenshots were written (relative to the Site dir). */
  screenshotsDir: string;
  /** Where the model must write its findings (relative to the Site dir). */
  auditMdPath: string;
  profileMdPath: string;
  profileJsonPath: string;
}

/** The review + one-fix-pass prompt. */
export function buildAuditPrompt(input: AuditPromptInput): string {
  return [
    `You are the audit reviewer for a freshly generated marketing website for`,
    `"${input.clientName}". The Site already builds; your job is to review it for`,
    "quality and correctness and then fix what you find, in this one run.",
    "",
    "Inputs to review:",
    `- ${input.checksJsonPath} — deterministic checks already run for you: axe-core`,
    "  accessibility violations (per page) and broken internal links/assets.",
    `- ${input.screenshotsDir}/ — desktop + mobile screenshots of each page, for`,
    "  visual quality (layout, spacing, hierarchy, contrast, responsiveness).",
    "- The built Site source in this directory (your working directory) — read it",
    "  directly for content accuracy and leftover placeholders.",
    `- ${input.profileMdPath} and ${input.profileJsonPath} — the Client Profile, the`,
    "  source of truth for the business facts the Site must reflect.",
    "",
    "Review for, at least:",
    "- Visual quality: anything that looks broken, unbalanced, low-contrast, or",
    "  unfinished on desktop or mobile.",
    "- Content accuracy: copy that contradicts the Profile, and any leftover",
    '  placeholders ("Service One", lorem ipsum, fake or template contact details).',
    "- Accessibility: the axe violations in the checks file (and anything else).",
    "- Links/assets: the broken references in the checks file.",
    "",
    "Then act, in order:",
    `1. Write your findings to ${input.auditMdPath} as Markdown: a short summary, then`,
    "   sections for Visual, Content, Accessibility, and Links/Assets. For each",
    "   finding note its severity and whether you fixed it in this pass.",
    "2. Apply ONE fix pass: edit the Site source to resolve the findings you can.",
    "   Prefer real fixes (correct copy, fix contrast via the theme tokens, add alt",
    "   text, repair links). Keep edits scoped; do not rewrite the whole Site.",
    "",
    "Constraints:",
    "- Do NOT run `npm`, `astro build`, or `astro dev` — the pipeline re-gates the",
    "  build after you finish.",
    "- Preserve the Kit floor: one <header>/<main>/<footer>, the skip link, the",
    "  title/description/canonical/OG/JSON-LD meta, visible focus states, and the",
    "  reduced-motion rules.",
    "- Communicate only by writing audit/audit.md and editing files; print nothing.",
  ].join("\n");
}
