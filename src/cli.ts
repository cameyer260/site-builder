import pc from "picocolors";
import { buildCommand } from "./commands/build.ts";
import { configCommand } from "./commands/config.ts";
import { editCommand } from "./commands/edit.ts";
import { listCommand } from "./commands/list.ts";
import { pushCommand } from "./commands/push.ts";
import { removeCommand } from "./commands/remove.ts";
import { resumeCommand } from "./commands/resume.ts";
import { setCommand } from "./commands/set.ts";
import { showCommand } from "./commands/show.ts";
import { statusCommand } from "./commands/status.ts";
import { variantCommand } from "./commands/variant.ts";
import { UserError } from "./util/errors.ts";

const HELP = `${pc.bold("sb")} — Site Builder

Usage: sb <command> [options]

Commands:
  config                 Interactive setup
  config get <key>       Print a config value
  config set <key> <v>   Update a config value
  config doctor          Check the environment (engine, wrangler, gh, root, keys)
  config path            Print the config file path

  build <client> …       Create a Client and run the full pipeline, or smartly
                         continue/refresh an existing one
                         inputs: --url --docs --images --notes --pages
                         generate: --vibe <text> --style <text> --yes (skip QA;
                         warned + ignored when a continue is past generate)
                         continue: --refresh (re-ingest) --github (publish repo)
  variant <client>       Generate a new Site Version from existing context
                         flags: --vibe --style --github --yes
  resume <client>        Continue a failed run from its last incomplete stage
                         flags: --vibe --style --yes (warned + ignored if the
                         resume is already past the generate stage)
  push <client>          Publish a Site Version's source to a private GitHub repo
                         flags: --version <n>
  remove <client>        Permanently erase a Client and all their data, or one
                         Site Version — tears down its Cloudflare deploy(s) and
                         GitHub repo(s) first, then the local files
                         flags: --version <n> (else the whole Client) --yes
                         (skip confirmation) --dry-run --local-only --force

  list                   List all Clients and their latest deploy links
  show <client>          Show a Client's CRM record
  set <client> <f> <v>   Set a CRM field (name, contact.*, notes, url)
  edit <client>          Open a Client's client.json in $EDITOR
  status <client>        Show pipeline state for a Client

  help                   Show this help

Notes:
  SB_STUB_FAIL=<stage>   Force a stub stage to fail (dev/testing)`;

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case undefined:
      case "help":
      case "-h":
      case "--help":
        console.log(HELP);
        return 0;
      case "config":
        return await configCommand(rest);
      case "doctor":
        return await configCommand(["doctor"]);
      case "build":
        return await buildCommand(rest);
      case "variant":
        return await variantCommand(rest);
      case "resume":
        return await resumeCommand(rest);
      case "push":
        return await pushCommand(rest);
      case "remove":
        return await removeCommand(rest);
      case "list":
        return await listCommand(rest);
      case "show":
        return await showCommand(rest);
      case "set":
        return await setCommand(rest);
      case "edit":
        return await editCommand(rest);
      case "status":
        return await statusCommand(rest);
      default:
        console.error(pc.red(`unknown command: ${command}`));
        console.error(HELP);
        return 1;
    }
  } catch (err) {
    if (err instanceof UserError) {
      console.error(pc.red(`error: ${err.message}`));
      if (err.hint) {
        console.error(pc.dim(err.hint));
      }
      return 1;
    }
    console.error(pc.red("unexpected error:"));
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    return 1;
  }
}
