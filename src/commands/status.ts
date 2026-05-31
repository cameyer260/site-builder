import { parseArgs } from "node:util";
import pc from "picocolors";
import { loadConfigOrThrow } from "../config/store.ts";
import { stageNamesFor } from "../pipeline/pipeline.ts";
import { readClient } from "../storage/client.ts";
import { clientExists, clientPaths, latestVersion } from "../storage/layout.ts";
import { readState, type StageStatus, type State } from "../storage/state.ts";
import { UserError } from "../util/errors.ts";

const USAGE = "usage: sb status <client>";

const GLYPH: Record<StageStatus, string> = {
  pending: pc.dim("○ pending"),
  running: pc.cyan("◐ running"),
  completed: pc.green("● completed"),
  failed: pc.red("✗ failed"),
};

function printPhase(title: string, stageNames: string[], state: State | null): void {
  console.log(pc.bold(title));
  for (const name of stageNames) {
    const record = state?.stages[name];
    const status: StageStatus = record?.status ?? "pending";
    const suffix = record?.error ? pc.red(` — ${record.error}`) : "";
    console.log(`  ${name.padEnd(12)} ${GLYPH[status]}${suffix}`);
  }
  if (state?.lastRun) {
    const { status, stage, at } = state.lastRun;
    console.log(pc.dim(`  last run: ${status}${stage ? ` @ ${stage}` : ""} (${at})`));
  } else {
    console.log(pc.dim("  last run: —"));
  }
}

export async function statusCommand(args: string[]): Promise<number> {
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
  const version = latestVersion(paths.sites) ?? 1;

  console.log(pc.bold(`Client: ${client?.name ?? name}`));
  console.log(pc.dim(`  dir: ${paths.dir}`));
  console.log("");

  printPhase("Context phase", stageNamesFor("context"), readState(paths.state));
  console.log("");
  printPhase(
    `Generation phase (v${version})`,
    stageNamesFor("generation"),
    readState(paths.versionState(version)),
  );

  return 0;
}
