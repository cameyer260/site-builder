import { parseArgs } from "node:util";
import pc from "picocolors";
import { loadConfigOrThrow } from "../config/store.ts";
import { CLIENT_FIELD_KEYS, setClientField } from "../storage/client.ts";
import { clientExists, clientPaths } from "../storage/layout.ts";
import { UserError } from "../util/errors.ts";

const USAGE = `usage: sb set <client> <field> <value>\nfields: ${CLIENT_FIELD_KEYS.join(", ")}`;

/**
 * `sb set` — write one scalar CRM field on a Client's `client.json` (ADR-0003).
 * For arrays and bulk edits, use `sb edit`. The write is re-validated against the
 * schema, so it can never corrupt the record.
 */
export async function setCommand(args: string[]): Promise<number> {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  const [name, field, ...valueParts] = positionals;
  if (!name || !field || valueParts.length === 0) {
    throw new UserError("missing arguments", USAGE);
  }

  const config = loadConfigOrThrow();
  if (!clientExists(config.root, name)) {
    throw new UserError(`no Client found for "${name}"`, "run `sb build` first");
  }

  const paths = clientPaths(config.root, name);
  setClientField(paths.clientJson, field, valueParts.join(" "));
  console.log(pc.green(`✓ set ${field} on "${name}"`));
  return 0;
}
