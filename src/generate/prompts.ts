import type { AssetManifestEntry } from "../synthesize/profile.ts";
import { capturedAssetPath } from "./assets.ts";

/**
 * Prompts for the two `generate` engine calls (the Design Brief and the Site
 * build). Per ADR-0006 the tool's own instructions stay thin — tool
 * orchestration and output contracts only — and the design intelligence
 * (palettes, fonts, styles, a11y/perf guardrails) comes from the installed
 * `ui-ux-pro-max` skill the prompts tell the model to invoke. As elsewhere, the
 * model communicates by writing on-disk artifacts, not by returning prose.
 */

/** Thin orchestration directives appended to the system prompt for the build call. */
export const GENERATE_SYSTEM_PROMPT = [
  "You are the `generate` stage of the Site Builder pipeline.",
  "Build on the provided Astro Kit — never scaffold a project from scratch.",
  "The Design Brief and Client Profile are the source of truth.",
  "Obtain design intelligence (palettes, font pairings, styles, and the",
  "accessibility/performance/typography guardrails) from the `ui-ux-pro-max`",
  "skill rather than re-deriving it.",
  "The Kit is a quality floor and a parts box, not a template to reproduce —",
  "compose a site whose look is distinctive to this Client.",
  "Produce results only by writing files in the project; do not print explanations.",
].join(" ");

export interface BriefPromptInput {
  clientName: string;
  /** `.site-builder/` — where brief.md/brief.json are written (see `artifacts.ts`). */
  artifactsDir: string;
  profileMdPath: string;
  profileJsonPath: string;
  logoPath?: string;
  screenshotsDir?: string;
  vibe?: string;
  style?: string;
}

/** Engine call 1: derive the Design Brief → `.site-builder/brief.md` (+ `brief.json`). */
export function buildBriefPrompt(input: BriefPromptInput): string {
  const lines = [
    `You are an art director defining the Design Brief — the explicit visual`,
    `direction — for a new marketing website for "${input.clientName}".`,
    "",
    "Read the Client Profile first:",
    `- ${input.profileMdPath} (human-readable)`,
    `- ${input.profileJsonPath} (structured fields incl. industry, audience, brand voice)`,
    "",
    "Use the `ui-ux-pro-max` skill for design intelligence: choose a color",
    "palette, a Google-Fonts type pairing (a display/heading face + a readable",
    "body face), and an overall style/mood that suit this industry and audience.",
    "",
    "Commit to a specific, considered visual direction that genuinely fits THIS",
    "business — its industry, audience, brand personality, and any brand cues in",
    'its logo and existing site. Do not settle for a generic "clean, modern,',
    'trustworthy" default: two different businesses should yield visibly different',
    "Briefs. The direction is yours to derive from the findings.",
    "",
  ];
  if (input.logoPath) {
    lines.push(
      `Open the logo at ${input.logoPath} and extract the brand's core colors`,
      "(you may use the skill's brand color-extraction approach); build the",
      "palette around them.",
      "",
    );
  }
  if (input.screenshotsDir) {
    lines.push(
      `Skim the existing-site screenshots in ${input.screenshotsDir} for brand`,
      "cues to evolve — do not copy the old design.",
      "",
    );
  }
  if (input.vibe || input.style) {
    const parts = [
      input.vibe ? `vibe="${input.vibe}"` : "",
      input.style ? `style="${input.style}"` : "",
    ].filter(Boolean);
    lines.push(`Operator creative direction (treat as strong guidance): ${parts.join(", ")}.`, "");
  }
  lines.push(
    "Decide and record:",
    "- Palette: brand / accent / ink / surface with explicit hex (or oklch) values,",
    "  honoring any extracted brand colors.",
    "- Type pairing: heading + body font names (must exist on Google Fonts).",
    '- Style & mood: a few words (e.g. "warm, trustworthy, local").',
    "- Layout character and imagery style.",
    "",
    `Write exactly two files into ${input.artifactsDir}:`,
    "1. brief.md — the human-readable Design Brief (the primary artifact generate",
    "   reads): sections for palette (list the hex values), typography, style/mood,",
    "   layout, and imagery.",
    '2. brief.json — { "palette": { "brand": "#…", "accent": "#…", "ink": "#…", "surface": "#…" },',
    '   "fonts": { "heading": "…", "body": "…" }, "style": "…", "mood": "…", "imagery": "…" }',
    "",
    "Write ONLY those two files. Do not print anything else.",
  );
  return lines.join("\n");
}

export interface GeneratePromptInput {
  clientName: string;
  profileMdPath: string;
  profileJsonPath: string;
  assets: AssetManifestEntry[];
  imagesJsonPath: string;
}

/**
 * Renders one explicit line per Asset — spelling out role, its already-staged
 * path, and (for the logo) the requirement to use it — so `generate` is
 * handed the facts directly instead of having to notice and cross-reference
 * `profile.json`. Points at `capturedAssetPath`, not `profile.json`'s own
 * `file` (a `context/` path outside this project) — `placeCapturedAssets`
 * copies each Asset to that location before this prompt ever runs, so the
 * Engine only has to reference an existing file, never locate or copy one.
 *
 * Excludes `icon`: `placeFavicon` already swapped it into `public/` and
 * repointed the Kit's `<link rel="icon">` in code, with no build-call
 * involvement — listing it here would just invite the model to also try
 * wiring it through `astro:assets`, which isn't how a favicon works.
 */
function renderAssetLines(assets: AssetManifestEntry[]): string[] {
  const relevant = assets.filter((a) => a.role !== "icon");
  if (relevant.length === 0) {
    return ["   (none captured — rely on stock photography for step 4 below.)"];
  }
  return relevant.map((a) => {
    const description = a.description ? ` — depicts: ${a.description}` : "";
    const requirement = a.role === "logo" ? " — use this as the site's logo/brand mark" : "";
    return `   - ${a.role} → ${capturedAssetPath(a.file)}${description}${requirement}`;
  });
}

/** Engine call 2: build the Site on top of the copied Kit. */
export function buildGeneratePrompt(input: GeneratePromptInput): string {
  return [
    `You are building a production-quality marketing website for "${input.clientName}"`,
    "on top of the Site Builder Kit in this directory (your working directory).",
    "",
    "The Kit's pages (src/pages/*.astro) are intentionally near-empty skeletons —",
    "each is just a placeholder <h1> and a compose-me comment. `BaseLayout.astro`",
    "provides the floor you must keep: SEO meta, the <header>/<main>/<footer>",
    "landmarks, and the skip link. But the `Navigation` and `Footer` it renders",
    "are also neutral, unstyled skeletons — restyle and compose them (including",
    "the responsive/mobile nav) per the Brief, just like the page bodies. Your job",
    "is to design and compose a real site on top of that floor, not to recolor a",
    "finished template — there is no finished template here to recolor.",
    "",
    "Start by reading the Kit's own CLAUDE.md — it documents the Kit's structure,",
    "what to preserve (the SEO / accessibility / performance floor), and what to",
    "tailor. Follow it.",
    "",
    "Source of truth — read these:",
    "- ./.site-builder/brief.md — the Design Brief: the palette, fonts, style/mood,",
    "  layout character, and imagery direction derived for this Client. Honor it.",
    `- ${input.profileMdPath} — the Client Profile (all the business facts, incl. Assets).`,
    `- ${input.profileJsonPath} — machine facts: \`fields\`, each with a status.`,
    "",
    "(`.site-builder/` holds pipeline-only artifacts — the Design Brief above, plus",
    " the image-sourcing manifest you'll write in step 4 below. It is not site",
    " content: never reference it from Astro code, and leave it in place.)",
    "",
    "Use the `ui-ux-pro-max` skill for design execution (layout, spacing, type",
    "scale, component patterns, accessibility).",
    "",
    "Build the Site:",
    "1. Compose each page: choose a section set, an order, a hero treatment, and a",
    "   decorative language that fit THIS Client and the Brief's direction —",
    "   this is a first-class, REQUIRED design decision, not a formality. Build",
    "   pages from the Kit's primitive components (`Button`, `ContactForm`, `FAQ`,",
    "   `MapEmbed`, `BusinessHours`, `LocalBusinessSchema`) and/or your own new",
    "   components. The Kit ships no card or section-heading presets — compose",
    "   those yourself to fit this Client. Either way the primitives are a parts",
    "   box, not a page layout. Do not reproduce a single",
    "   uniform template across clients: two different Clients' sites — or two",
    "   variants of the same Client — should be able to look meaningfully",
    "   different because their Briefs differ.",
    "2. Theme to the Brief: override the `@theme` tokens in src/styles/global.css so",
    "   the brand color ramp and fonts match .site-builder/brief.json, and load the",
    "   Brief's Google Fonts in the layout <head>. You may add new `@theme` tokens",
    "   or utilities as the Brief warrants. Editing theme.css is allowed when the",
    "   Brief's direction calls for it, but keep its accessibility/motion guardrails",
    "   intact (focus states, `prefers-reduced-motion`, the `.js [data-reveal]`",
    "   fallback). theme.css ships only neutral tokens and generic entrance",
    "   animations — no mesh-gradient, blob, dot-grid, or gradient-text presets. If",
    "   the Brief's direction calls for decorative effects (gradient washes, glow,",
    "   textures, motion), compose them yourself for this Site rather than reaching",
    "   for a shared preset.",
    "3. Wire real content: replace src/data/site.ts and every placeholder string with",
    "   the Client's real facts. For fields flagged Guessed in profile.json (including",
    "   those with a null value), write plausible, on-brand copy so the Site is",
    '   complete — never leave "Service One", lorem ipsum, or fake-looking contact',
    "   details.",
    "4. Assets: these were captured from the Client's own existing site/materials",
    "   and are already staged in this project — no need to copy or fetch",
    "   anything. Reference the ones that fit through astro:assets and",
    "   src/assets/index.ts (add an export alongside the Kit's defaults, the same",
    "   way you wire stock photography below). Prefer them over stock photography",
    "   or a hand-drawn/redrawn substitute — they are real and already the",
    "   Client's own. Only skip one if it is genuinely unusable (corrupted,",
    "   unreadable, wrong subject) — never merely because you would prefer a",
    "   different look. (The favicon, if captured, is handled separately — already",
    "   swapped in; nothing to do there.)",
    ...renderAssetLines(input.assets),
    "5. Photography you still need: do NOT download images or hot-link remote URLs.",
    `   For each photo slot, add an entry to ${input.imagesJsonPath} as JSON:`,
    '   { "slots": [ { "id": "<lowercase-slug>", "query": "<search keywords>",',
    '     "alt": "<alt text>", "orientation": "landscape|portrait|square" } ] }',
    "   and reference that image in your Astro code at `@/assets/stock/<id>.jpg` via",
    "   astro:assets. The pipeline fetches and places each file before compiling —",
    "   reference only ids you declared.",
    "6. Adapt freely: add, remove, or restructure pages and components from the Kit to",
    "   fit the Profile (local-business, services, or product site — whatever fits).",
    "   Keep nav, footer, and contact details consistent and real.",
    "",
    "Constraints:",
    "- Do NOT run `npm`, `astro build`, or `astro dev` — the pipeline runs the gate.",
    "- Preserve the Kit's quality floor: one <header>/<main>/<footer>, the skip link,",
    "  title/description/canonical/OG/JSON-LD meta, visible focus states, and the",
    "  reduced-motion rules.",
    "- Keep TypeScript and Astro happy (no broken imports). Communicate only by",
    "  editing files; do not print a summary.",
  ].join("\n");
}
