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
 * `generate`, between the Context and Generation phases. It surfaces each
 * Unknown Checklist field for the operator to answer or skip — answered items
 * become Known (user-provided), skipped items (and every Unknown on a
 * non-interactive run) become Guessed for the AI build to infer plausibly. The
 * resolved Profile is persisted back to `context/`, so a complete, deployable
 * prototype can always be produced and future variants inherit the answers.
 */

const PROMPT_BY_KEY = new Map(CHECKLIST.map((i) => [i.key, i.prompt]));
const PROVIDED_NOTE = "provided in QA session";
const DEFERRED_NOTE = "left for AI to infer (QA skipped)";

/** One operator response to a surfaced Unknown field. */
export type QaResponse = { kind: "answer"; value: string } | { kind: "skip" } | { kind: "cancel" };

/** Asks the operator about one field. Injected so tests can drive it offline. */
export type QaAsk = (field: { key: string; label: string; prompt: string }) => Promise<QaResponse>;

export interface QaParams {
  profile: Profile;
  /** The Client's `context/` dir; QA persists the resolved Profile here. */
  contextDir: string;
  /** Whether the run may prompt. False (CI / `--yes`) → all Unknowns Guessed. */
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
 * Runs the QA gate over a Profile's Unknown fields and persists the result.
 * Returns the same Profile object, mutated. A no-op (beyond logging) when there
 * are no Unknown fields left.
 */
export async function runQaSession(params: QaParams): Promise<Profile> {
  const { profile, contextDir, interactive, log } = params;
  const ask = params.ask ?? defaultQaAsk;
  const unknown = profile.fields.filter((f) => f.status === "Unknown");

  if (unknown.length === 0) {
    log.step("qa: no open questions — every Checklist item is Known or Guessed");
    return profile;
  }

  let answered = 0;
  let deferred = 0;

  if (!interactive) {
    for (const field of unknown) {
      markGuessed(field);
      deferred += 1;
    }
    log.step(`qa: non-interactive — ${deferred} Unknown field(s) left for AI to infer`);
  } else {
    p.intro(pc.bold(`QA session — ${profile.client}`));
    p.log.message(
      `${unknown.length} open question(s). Answer what you can; press Enter to skip ` +
        "(skipped items are filled in by AI and flagged for review).",
    );
    let cancelled = false;
    for (const field of unknown) {
      if (cancelled) {
        markGuessed(field);
        deferred += 1;
        continue;
      }
      const response = await ask({
        key: field.key,
        label: field.label,
        prompt: PROMPT_BY_KEY.get(field.key) ?? "",
      });
      if (response.kind === "answer") {
        field.status = "Known";
        field.value = response.value;
        field.note = PROVIDED_NOTE;
        answered += 1;
      } else {
        if (response.kind === "cancel") {
          cancelled = true;
        }
        markGuessed(field);
        deferred += 1;
      }
    }
    p.outro(`${answered} answered, ${deferred} left for AI to infer`);
  }

  persist(contextDir, profile);
  log.success(`qa: ${answered} answered, ${deferred} left for AI to infer`);
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
