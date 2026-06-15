import { parseArgs } from "node:util";
import pc from "picocolors";
import { loadConfigOrThrow } from "../config/store.ts";
import { runPush } from "../github/push.ts";
import { smartBuild } from "../pipeline/orchestrator.ts";
import { buildRunContext } from "../runtime.ts";
import { type ClientInputs, ClientInputsSchema, mergeClientInputs } from "../storage/client.ts";
import { clientExists, clientPaths } from "../storage/layout.ts";
import { UserError } from "../util/errors.ts";

const USAGE =
  "usage: sb build <client> [--url <url>] [--docs <path>…] [--images <path>…] [--notes <text>] [--pages <n>] [--vibe <text>] [--style <text>] [--refresh] [--github] [--yes]";

/** Flattens repeated and comma-separated list flags into a clean string[]. */
function splitList(values: string[] | undefined): string[] {
  return (values ?? [])
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

export async function buildCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      url: { type: "string" },
      docs: { type: "string", multiple: true },
      images: { type: "string", multiple: true },
      notes: { type: "string" },
      pages: { type: "string" },
      vibe: { type: "string" },
      style: { type: "string" },
      refresh: { type: "boolean" },
      github: { type: "boolean" },
      yes: { type: "boolean", short: "y" },
    },
  });

  const name = positionals[0];
  if (!name) {
    throw new UserError("missing client name", USAGE);
  }

  const inputs: ClientInputs = ClientInputsSchema.parse({
    url: values.url,
    docs: splitList(values.docs),
    images: splitList(values.images),
    notes: values.notes,
  });
  const hasNewInputs =
    Boolean(inputs.url) ||
    inputs.docs.length > 0 ||
    inputs.images.length > 0 ||
    Boolean(inputs.notes);

  const config = loadConfigOrThrow();
  const exists = clientExists(config.root, name);

  // At least one Input is required only to create a *new* Client (CONTEXT.md >
  // Input). An existing Client already has its Inputs on record, so a bare
  // `sb build`/`--refresh` re-uses them.
  if (!exists && !hasNewInputs) {
    throw new UserError(
      "at least one Input is required for a new Client",
      "pass --url, --docs, --images, or --notes",
    );
  }

  let pageCap: number | undefined;
  if (values.pages !== undefined) {
    pageCap = Number(values.pages);
    if (!Number.isInteger(pageCap) || pageCap <= 0) {
      throw new UserError(`--pages expects a positive integer, got "${values.pages}"`);
    }
  }

  // Re-passing Inputs to an existing Client both folds them into the record and
  // triggers a context refresh (ADR-0008). `--refresh` forces it with no new
  // Inputs (re-crawl the same ones).
  if (exists && hasNewInputs) {
    mergeClientInputs(clientPaths(config.root, name).clientJson, inputs);
  }
  const refresh = Boolean(values.refresh) || hasNewInputs;

  // The QA gate prompts only on a real terminal and when not waved through with --yes.
  const interactive = Boolean(process.stdin.isTTY) && !values.yes;

  const ctx = buildRunContext({
    config,
    name,
    version: 1, // smartBuild sets the real target version.
    command: "build",
    inputs,
    pageCap,
    interactive,
    vibe: values.vibe,
    style: values.style,
  });
  ctx.log.step(`building Client "${name}" at ${ctx.paths.dir}`);

  const result = await smartBuild(ctx, {
    refresh: exists && refresh,
    flags: { vibe: values.vibe, style: values.style, yes: values.yes },
  });

  if (!result.ok) {
    console.error(
      pc.dim(
        `run \`sb resume ${name}\` to retry from "${result.failedStage}", or \`sb status ${name}\` to inspect`,
      ),
    );
    return 1;
  }

  if (result.kind === "noop") {
    ctx.log.success(`nothing to build — Site v${result.version} is already complete`);
    console.error(
      pc.dim(
        `use \`sb variant ${name}\` for a new take, or pass new Inputs / \`--refresh\` to rebuild`,
      ),
    );
    return 0;
  }

  ctx.log.success(`build complete — ran ${result.ran.join(" → ")}`);

  if (values.github) {
    await runPush({ paths: ctx.paths, version: result.version, ghBin: config.ghBin, log: ctx.log });
  }
  return 0;
}
