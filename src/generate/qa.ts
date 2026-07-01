import { appendFileSync } from "node:fs";
import { join } from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { CHECKLIST } from "../synthesize/checklist.ts";
import { displayFieldValue, type Profile, type ProfileField } from "../synthesize/profile.ts";
import { persistProfile } from "../synthesize/synthesize.ts";
import type { Logger } from "../util/log.ts";

/**
 * The **QA session** (CONTEXT.md): the optional interactive gate at the start of
 * `generate`, between the Context and Generation phases. It surfaces every
 * Unknown and every Guessed Checklist field for the operator to answer or
 * verify — answered items become Known (user-provided), skipped items (and
 * every Unknown on a non-interactive run) remain or become Guessed for the AI
 * build to infer plausibly. The resolved Profile is persisted back to
 * `context/`, so a complete, deployable prototype can always be produced and
 * future variants inherit the answers.
 */

const PROMPT_BY_KEY = new Map(CHECKLIST.map((i) => [i.key, i.prompt]));
const PROVIDED_NOTE = "provided in QA session";
const DEFERRED_NOTE = "left for AI to infer (QA skipped)";
const QA_SOURCE = "QA session";

/** One operator response to a surfaced field. */
export type QaResponse = { kind: "answer"; value: string } | { kind: "skip" } | { kind: "cancel" };

/** Asks the operator about one field. Injected so tests can drive it offline. */
export type QaAsk = (field: { key: string; label: string; prompt: string }) => Promise<QaResponse>;

export interface QaParams {
  profile: Profile;
  /** The Client's `context/` dir; QA persists the resolved Profile here. */
  contextDir: string;
  /** Whether the run may prompt. False (CI / `--yes`) → all Unknowns become Guessed. */
  interactive: boolean;
  log: Logger;
  /** Defaults to a `@clack/prompts` text prompt per field. */
  ask?: QaAsk;
}

/** The default per-field prompt: a text input where an empty answer means skip. */
async function defaultQaAsk(field: { label: string; prompt: string }): Promise<QaResponse> {
  const answer = await p.text({
    message: `${field.label} ${pc.dim("(Enter to skip)")}`,
    placeholder: field.prompt,
  });
  if (p.isCancel(answer)) {
    return { kind: "cancel" };
  }
  const trimmed = (answer ?? "").trim();
  return trimmed.length > 0 ? { kind: "answer", value: trimmed } : { kind: "skip" };
}

function markGuessed(field: ProfileField): void {
  field.status = "Guessed";
  // Value stays null; the generate build writes plausible, on-brand content for
  // it. The Guessed flag keeps it on the Checklist for later verification.
  field.note = field.note ?? DEFERRED_NOTE;
}

/**
 * Runs the QA gate over a Profile's Unknown and Guessed fields and persists the
 * result. Returns the same Profile object, mutated. A no-op (beyond logging)
 * when there are no open fields left.
 */
export async function runQaSession(params: QaParams): Promise<Profile> {
  const { profile, contextDir, interactive, log } = params;
  const ask = params.ask ?? defaultQaAsk;
  const guessed = profile.fields.filter((f) => f.status === "Guessed");
  const unknown = profile.fields.filter((f) => f.status === "Unknown");
  const open = [...guessed, ...unknown];

  if (open.length === 0) {
    log.step("qa: no open questions — every Checklist item is Known");
    return profile;
  }

  let answered = 0;

  if (!interactive) {
    let newlyGuessed = 0;
    for (const field of unknown) {
      markGuessed(field);
      newlyGuessed += 1;
    }
    const totalGuessed = profile.fields.filter((f) => f.status === "Guessed").length;
    log.step(
      `qa: non-interactive — ${newlyGuessed} Unknown field(s) left for AI to infer ` +
        `(${totalGuessed} Guessed total)`,
    );
  } else {
    p.intro(pc.bold(`QA session — ${profile.client}`));
    const parts: string[] = [];
    if (guessed.length > 0) parts.push(`${guessed.length} guessed value(s) to verify`);
    if (unknown.length > 0) parts.push(`${unknown.length} open question(s)`);
    p.log.message(
      `${parts.join(" and ")}. Answer what you can; press Enter to skip ` +
        "(skipped items are filled in by AI and flagged for review).",
    );
    let cancelled = false;
    for (const field of open) {
      if (cancelled) {
        if (field.status === "Unknown") {
          markGuessed(field);
        }
        continue;
      }
      const isGuessed = field.status === "Guessed";
      const prompt = isGuessed
        ? `Current guess: ${displayFieldValue(field.value)} — ${PROMPT_BY_KEY.get(field.key) ?? ""}`
        : (PROMPT_BY_KEY.get(field.key) ?? "");
      const response = await ask({
        key: field.key,
        label: field.label,
        prompt,
      });
      if (response.kind === "answer") {
        field.status = "Known";
        field.value = response.value;
        field.note = PROVIDED_NOTE;
        field.source = QA_SOURCE;
        answered += 1;
      } else {
        if (response.kind === "cancel") {
          cancelled = true;
        }
        if (field.status === "Unknown") {
          markGuessed(field);
        }
      }
    }
    const deferred = profile.fields.filter((f) => f.status === "Guessed").length;
    p.outro(`${answered} answered, ${deferred} left for AI to infer`);
  }

  persist(contextDir, profile);
  const finalGuessed = profile.fields.filter((f) => f.status === "Guessed").length;
  log.success(`qa: ${answered} answered, ${finalGuessed} left for AI to infer`);
  return profile;
}

/**
 * Writes the resolved Profile back into `context/`: the machine sidecar
 * (`profile.json`), the re-derived Checklist gaps (`checklist.md`), and an
 * appended section in the human Profile (`profile.md`) recording the operator's
 * answers so the generate build reads them as first-class facts.
 */
function persist(contextDir: string, profile: Profile): void {
  persistProfile(contextDir, profile);

  const provided = profile.fields.filter((f) => f.note === PROVIDED_NOTE);
  if (provided.length > 0) {
    const lines = [
      "",
      "## QA session answers",
      "",
      ...provided.map((f) => `- **${f.label}** (Known): ${displayFieldValue(f.value)}`),
      "",
    ];
    appendFileSync(join(contextDir, "profile.md"), lines.join("\n"));
  }
}
