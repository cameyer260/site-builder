import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import pc from "picocolors";
import { loadConfigOrThrow } from "../config/store.ts";
import { readClient } from "../storage/client.ts";
import { clientExists, clientPaths } from "../storage/layout.ts";
import { UserError } from "../util/errors.ts";

const USAGE = "usage: sb edit <client>";

/** The editor to open, honoring $VISUAL then $EDITOR, falling back to `vi`. */
function editorCommand(): string {
  return process.env.VISUAL || process.env.EDITOR || "vi";
}

/**
 * `sb edit` — open a Client's `client.json` in `$EDITOR` for hand-editing the CRM
 * facts (the AI-/human-editable record, ADR-0003), then re-validate it on save.
 * Machine-managed pipeline state lives in separate `state.json` files this never
 * touches, so a manual edit can't corrupt resume.
 */
export async function editCommand(args: string[]): Promise<number> {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  const name = positionals[0];
  if (!name) {
    throw new UserError("missing client name", USAGE);
  }

  const config = loadConfigOrThrow();
  if (!clientExists(config.root, name)) {
    throw new UserError(`no Client found for "${name}"`, "run `sb build` first");
  }

  const paths = clientPaths(config.root, name);
  const editor = editorCommand();
  const result = spawnSync(editor, [paths.clientJson], { stdio: "inherit" });
  if (result.error) {
    throw new UserError(`could not launch editor "${editor}": ${result.error.message}`);
  }
  if (typeof result.status === "number" && result.status !== 0) {
    throw new UserError(`editor "${editor}" exited with status ${result.status}`);
  }

  // Re-read to validate: readClient throws a UserError on malformed JSON or a
  // schema violation, surfacing the mistake immediately instead of at the next run.
  readClient(paths.clientJson);
  console.log(pc.green(`✓ saved client.json for "${name}"`));
  return 0;
}
