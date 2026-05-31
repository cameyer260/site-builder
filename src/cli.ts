import pc from "picocolors";
import { buildCommand } from "./commands/build.ts";
import { configCommand } from "./commands/config.ts";
import { resumeCommand } from "./commands/resume.ts";
import { statusCommand } from "./commands/status.ts";
import { UserError } from "./util/errors.ts";

const HELP = `${pc.bold("sb")} — Site Builder

Usage: sb <command> [options]

Commands:
  config                 Interactive setup
  config get <key>       Print a config value
  config set <key> <v>   Update a config value
  config doctor          Check the environment (engine, wrangler, root, keys)
  config path            Print the config file path

  build <client> …       Create a Client and run the full pipeline
                         flags: --url --docs --images --notes --pages
  resume <client>        Continue a failed run from its last incomplete stage
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
      case "resume":
        return await resumeCommand(rest);
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
