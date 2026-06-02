/**
 * The fixed, tool-shipped **Checklist** (CONTEXT.md): the questions worth
 * answering about any business to build a good site. The same starting set is
 * used for every Client in v1 — per-client/per-industry customization is a
 * deferred improvement (roadmap). `synthesize` fills these into the Client
 * Profile, each carrying a Field status (Known/Guessed/Unknown).
 */

export interface ChecklistItem {
  /** Stable machine key, used as the Profile field key. */
  readonly key: string;
  /** Human-readable label for the Profile and Checklist gaps file. */
  readonly label: string;
  /** What a good answer covers — guidance for the synthesizing model. */
  readonly prompt: string;
  /** Grouping for the rendered Profile. */
  readonly group: string;
}

export const CHECKLIST: readonly ChecklistItem[] = [
  // --- Identity ---
  {
    key: "companyName",
    label: "Company name",
    prompt: "The official business name as it should appear on the site.",
    group: "Identity",
  },
  {
    key: "tagline",
    label: "Tagline / one-liner",
    prompt: "A short phrase capturing what the business does or stands for.",
    group: "Identity",
  },
  {
    key: "industry",
    label: "Industry / category",
    prompt: "The trade or sector (e.g. plumbing, dental, boutique fitness).",
    group: "Identity",
  },
  {
    key: "mission",
    label: "Mission & story",
    prompt: "What the business does, why it exists, and any history/origin worth telling.",
    group: "Identity",
  },
  // --- Offering ---
  {
    key: "services",
    label: "Services / products",
    prompt: "The main services or products offered, ideally as a concrete list.",
    group: "Offering",
  },
  {
    key: "audience",
    label: "Target audience",
    prompt: "Who the business serves — customer type, needs, and any segments.",
    group: "Offering",
  },
  {
    key: "differentiators",
    label: "Differentiators / value proposition",
    prompt: "Why a customer should choose them over alternatives; standout strengths.",
    group: "Offering",
  },
  {
    key: "credentials",
    label: "Credentials / certifications / awards",
    prompt: "Licenses, certifications, affiliations, years in business, awards.",
    group: "Offering",
  },
  // --- Voice ---
  {
    key: "tone",
    label: "Brand voice & tone",
    prompt: "How the brand should sound (e.g. warm and approachable, premium, no-nonsense).",
    group: "Voice",
  },
  {
    key: "callToAction",
    label: "Primary call to action",
    prompt: "The main action a visitor should take (book, call, request a quote, buy).",
    group: "Voice",
  },
  {
    key: "testimonials",
    label: "Testimonials / reviews",
    prompt: "Customer quotes, ratings, or review highlights that build trust.",
    group: "Voice",
  },
  // --- Contact & logistics ---
  {
    key: "contactEmail",
    label: "Contact email",
    prompt: "The public email address for inquiries.",
    group: "Contact",
  },
  {
    key: "contactPhone",
    label: "Contact phone",
    prompt: "The public phone number for inquiries.",
    group: "Contact",
  },
  {
    key: "address",
    label: "Physical address",
    prompt: "Street address or premises, if the business has a physical location.",
    group: "Contact",
  },
  {
    key: "serviceArea",
    label: "Location / service area",
    prompt: "The geographic area served (city, region, radius, or 'online/nationwide').",
    group: "Contact",
  },
  {
    key: "hours",
    label: "Business hours",
    prompt: "Opening hours or availability, including emergency/after-hours if any.",
    group: "Contact",
  },
  {
    key: "socials",
    label: "Social media links",
    prompt: "Profile URLs (Instagram, Facebook, LinkedIn, etc.).",
    group: "Contact",
  },
];

/** Renders the Checklist as a guidance block for the synthesizing model. */
export function renderChecklistForPrompt(): string {
  return CHECKLIST.map((item) => `- \`${item.key}\` (${item.label}): ${item.prompt}`).join("\n");
}
