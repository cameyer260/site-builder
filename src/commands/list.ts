import { basename } from "node:path";
import { parseArgs } from "node:util";
import pc from "picocolors";
import { loadConfigOrThrow } from "../config/store.ts";
import { type Client, readClient } from "../storage/client.ts";
import { listClientDirs } from "../storage/layout.ts";

/**
 * `sb list` — the CRM index. Scans the Root for each `<slug>/client.json` (the
 * Root *is* the registry, ADR-0003) and prints one row per Client: name, Site
 * Version count, and the latest deploy link. No central index file to drift.
 */
export async function listCommand(args: string[]): Promise<number> {
  parseArgs({ args, allowPositionals: true, options: {} });
  const config = loadConfigOrThrow();

  const clients = listClientDirs(config.root)
    .map((dir) => ({ slug: basename(dir), client: readClient(`${dir}/client.json`) }))
    .filter((row): row is { slug: string; client: Client } => row.client !== null)
    .sort((a, b) => b.client.updatedAt.localeCompare(a.client.updatedAt));

  if (clients.length === 0) {
    console.log(pc.dim(`no Clients yet under ${config.root}`));
    console.log(pc.dim("run `sb build <name> --url …` to create one"));
    return 0;
  }

  for (const { slug, client } of clients) {
    const latest = client.sites.at(-1);
    const versions = client.sites.length === 1 ? "1 version" : `${client.sites.length} versions`;
    const link = latest?.deployUrl ? pc.cyan(latest.deployUrl) : pc.dim("not deployed");
    console.log(`${pc.bold(client.name)} ${pc.dim(`(${slug})`)}`);
    console.log(`  ${versions} · ${link}`);
  }
  return 0;
}
