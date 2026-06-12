import { parseArgs } from "node:util";
import pc from "picocolors";
import { loadConfigOrThrow } from "../config/store.ts";
import { readClient } from "../storage/client.ts";
import { clientExists, clientPaths } from "../storage/layout.ts";
import { UserError } from "../util/errors.ts";

const USAGE = "usage: sb show <client>";

function line(label: string, value: string | undefined): void {
  console.log(`  ${label.padEnd(10)} ${value ? value : pc.dim("—")}`);
}

/**
 * `sb show` — print one Client's CRM record (`client.json`): contact, Inputs,
 * socials/reviews/notes, and its Site Version pointers (deploy link + GitHub
 * remote). Reads only the editable facts; pipeline state is `sb status`.
 */
export async function showCommand(args: string[]): Promise<number> {
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
  const client = readClient(paths.clientJson);
  if (!client) {
    throw new UserError(`could not read client.json for "${name}"`);
  }

  console.log(pc.bold(client.name));
  console.log(pc.dim(`  ${paths.dir}`));
  console.log("");

  console.log(pc.bold("Contact"));
  line("name", client.contact.name);
  line("email", client.contact.email);
  line("phone", client.contact.phone);
  console.log("");

  console.log(pc.bold("Inputs"));
  line("url", client.inputs.url);
  line("docs", client.inputs.docs.length > 0 ? client.inputs.docs.join(", ") : undefined);
  line("images", client.inputs.images.length > 0 ? client.inputs.images.join(", ") : undefined);
  line("notes", client.notes ?? client.inputs.notes);
  console.log("");

  if (client.socials.length > 0 || client.reviews.length > 0) {
    console.log(pc.bold("CRM"));
    line("socials", client.socials.length > 0 ? client.socials.join(", ") : undefined);
    line("reviews", `${client.reviews.length}`);
    console.log("");
  }

  console.log(pc.bold("Site Versions"));
  if (client.sites.length === 0) {
    console.log(pc.dim("  none yet"));
  } else {
    for (const site of client.sites) {
      const link = site.deployUrl ? pc.cyan(site.deployUrl) : pc.dim("not deployed");
      console.log(`  v${site.version}  ${link}`);
      if (site.remote) {
        console.log(`      ${pc.dim("github:")} ${site.remote}`);
      }
    }
  }
  return 0;
}
