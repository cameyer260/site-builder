import { parseArgs } from "node:util";
import pc from "picocolors";
import { loadConfigOrThrow } from "../config/store.ts";
import { runBuild } from "../pipeline/orchestrator.ts";
import { buildRunContext } from "../runtime.ts";
import { type ClientInputs, ClientInputsSchema } from "../storage/client.ts";
import { clientExists } from "../storage/layout.ts";
import { UserError } from "../util/errors.ts";

const USAGE =
  "usage: sb build <client> [--url <url>] [--docs <path>…] [--images <path>…] [--notes <text>] [--pages <n>]";

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

  // At least one Input is required to run a Client (CONTEXT.md > Input).
  const hasInput =
    Boolean(inputs.url) ||
    inputs.docs.length > 0 ||
    inputs.images.length > 0 ||
    Boolean(inputs.notes);
  if (!hasInput) {
    throw new UserError(
      "at least one Input is required",
      "pass --url, --docs, --images, or --notes",
    );
  }

  if (values.pages !== undefined && !Number.isFinite(Number(values.pages))) {
    throw new UserError(`--pages expects a number, got "${values.pages}"`);
  }

  const config = loadConfigOrThrow();

  // Uniqueness guard: build is for new Clients only (ADR-0002).
  if (clientExists(config.root, name)) {
    throw new UserError(
      `a Client already exists for "${name}"`,
      `use \`sb resume ${name}\` to continue, or \`sb variant\` for a new Site Version`,
    );
  }

  const ctx = buildRunContext({ config, name, version: 1, command: "build", inputs });
  ctx.log.step(`building Client "${name}" at ${ctx.paths.dir}`);

  const result = await runBuild(ctx);
  if (result.ok) {
    ctx.log.success(`build complete — ran ${result.ran.join(" → ")}`);
    return 0;
  }

  console.error(
    pc.dim(
      `run \`sb resume ${name}\` to retry from "${result.failedStage}", or \`sb status ${name}\` to inspect`,
    ),
  );
  return 1;
}
