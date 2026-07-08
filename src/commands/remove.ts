import { parseArgs } from "node:util";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { loadConfigOrThrow } from "../config/store.ts";
import { previewRemoval, runRemove } from "../remove/remove.ts";
import { buildRunContext } from "../runtime.ts";
import { clientExists, clientPaths, latestVersion } from "../storage/layout.ts";
import { UserError } from "../util/errors.ts";

const USAGE =
  "usage: sb remove <client> [--version <n>] [--yes] [--dry-run] [--local-only] [--force]";

/**
 * `sb remove` — permanently erase a Client and all their data, or a single
 * Site Version (ADR-0012). The deliberate inverse of the create path: tears
 * down the hosted Cloudflare deployment(s)/project and any GitHub repos before
 * touching local files, then drops the CRM pointer. A per-Version removal
 * compacts every higher Version down by one so the `vN` sequence stays
 * gapless. Confirms interactively (retype the slug) unless `--yes`.
 */
export async function removeCommand(args: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      version: { type: "string" },
      yes: { type: "boolean", short: "y" },
      "dry-run": { type: "boolean" },
      "local-only": { type: "boolean" },
      force: { type: "boolean" },
    },
  });
  const name = positionals[0];
  if (!name) {
    throw new UserError("missing client name", USAGE);
  }

  const config = loadConfigOrThrow();
  if (!clientExists(config.root, name)) {
    throw new UserError(`no Client found for "${name}"`, "run `sb build` first");
  }

  const paths = clientPaths(config.root, name);
  let version: number | undefined;
  if (values.version !== undefined) {
    version = Number(values.version);
    if (!Number.isInteger(version) || version <= 0) {
      throw new UserError(`--version expects a positive integer, got "${values.version}"`);
    }
  }

  const preview = previewRemoval(paths, version);

  if (values["dry-run"]) {
    console.log(pc.bold(`Would remove ${describeScope(preview, paths.name)}:`));
    printPreview(preview);
    console.log(pc.dim("\ndry run — nothing was changed"));
    return 0;
  }

  if (!values.yes) {
    console.log(pc.yellow(pc.bold("This permanently deletes local files and hosted resources.")));
    console.log(pc.yellow("This cannot be undone."));
    printPreview(preview);
    const typed = await p.text({ message: `Type "${paths.slug}" to confirm:` });
    if (p.isCancel(typed) || typed !== paths.slug) {
      console.log(pc.dim("remove: cancelled"));
      return 1;
    }
  }

  const ctx = buildRunContext({
    config,
    name,
    version: version ?? latestVersion(paths.sites) ?? 1,
    command: "remove",
  });

  const result = await runRemove({
    paths,
    version,
    config,
    log: ctx.log,
    localOnly: Boolean(values["local-only"]),
    force: Boolean(values.force),
  });

  return result.ok ? 0 : 1;
}

function describeScope(preview: ReturnType<typeof previewRemoval>, name: string): string {
  return preview.scope === "client"
    ? `"${name}"`
    : `Site v${preview.versions[0]?.version} of "${name}"`;
}

function printPreview(preview: ReturnType<typeof previewRemoval>): void {
  for (const v of preview.versions) {
    const label = v.willShiftTo
      ? `v${v.version} ${pc.dim(`→ becomes v${v.willShiftTo}`)}`
      : `v${v.version}`;
    console.log(`  ${label}`);
    console.log(`    dir:    ${v.versionDir}`);
    console.log(`    deploy: ${v.deployUrl ?? pc.dim("not deployed")}`);
    console.log(`    github: ${v.remote ?? pc.dim("no repo")}`);
  }
  if (preview.deleteWholeProject) {
    console.log(
      pc.dim(
        "  the Cloudflare Pages project itself will be deleted (no Versions remain after this)",
      ),
    );
  }
  if (preview.mayBeActiveProduction) {
    console.log(
      pc.dim(
        "  this is likely Cloudflare's active production deployment — if so, Cloudflare will " +
          "refuse to delete it (no wrangler workaround) and it will be left live until this " +
          "Client's whole Cloudflare Pages project is deleted",
      ),
    );
  }
  if (preview.scope === "client") {
    console.log(pc.dim(`  local: ${preview.clientDir}`));
  }
}
