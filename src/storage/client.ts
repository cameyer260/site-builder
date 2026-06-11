import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { formatZodError } from "../config/schema.ts";
import { UserError } from "../util/errors.ts";
import type { ClientPaths } from "./layout.ts";

/**
 * `client.json` — the human- and AI-editable CRM record for one Client
 * (ADR-0003). Kept strictly separate from machine-managed `state.json` so
 * manual/AI edits can never corrupt resume state.
 */

export const ClientContactSchema = z.object({
  name: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
});

/** The Inputs attached to a Client (existing-site URL, documents, images, notes). */
export const ClientInputsSchema = z.object({
  url: z.string().optional(),
  docs: z.array(z.string()).default([]),
  images: z.array(z.string()).default([]),
  notes: z.string().optional(),
});
export type ClientInputs = z.infer<typeof ClientInputsSchema>;

/** A pointer to one generated Site Version. */
export const SiteVersionRefSchema = z.object({
  version: z.number().int().positive(),
  deployUrl: z.string().optional(),
  repoPath: z.string().optional(),
  remote: z.string().optional(),
});
export type SiteVersionRef = z.infer<typeof SiteVersionRefSchema>;

export const ClientSchema = z.object({
  name: z.string().min(1),
  contact: ClientContactSchema.default({}),
  inputs: ClientInputsSchema.default(() => ClientInputsSchema.parse({})),
  socials: z.array(z.string()).default([]),
  reviews: z.array(z.string()).default([]),
  notes: z.string().optional(),
  sites: z.array(SiteVersionRefSchema).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Client = z.infer<typeof ClientSchema>;

function nowIso(): string {
  return new Date().toISOString();
}

export function newClient(name: string, inputs: ClientInputs): Client {
  const ts = nowIso();
  return ClientSchema.parse({
    name,
    inputs,
    createdAt: ts,
    updatedAt: ts,
  });
}

export function readClient(clientJsonPath: string): Client | null {
  if (!existsSync(clientJsonPath)) {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(clientJsonPath, "utf8"));
  } catch {
    throw new UserError(`client.json at ${clientJsonPath} is not valid JSON`);
  }
  const parsed = ClientSchema.safeParse(raw);
  if (!parsed.success) {
    throw new UserError(
      `client.json at ${clientJsonPath} is invalid: ${formatZodError(parsed.error)}`,
    );
  }
  return parsed.data;
}

export function writeClient(clientJsonPath: string, client: Client): void {
  const next = ClientSchema.parse({ ...client, updatedAt: nowIso() });
  mkdirSync(dirname(clientJsonPath), { recursive: true });
  writeFileSync(clientJsonPath, `${JSON.stringify(next, null, 2)}\n`);
}

/**
 * Upserts a Site Version pointer on the Client record (ADR-0003): merges into an
 * existing entry for the same version (preserving other fields like `repoPath` /
 * `remote`) or appends a new one, keeping `sites` ordered by version. `deploy`
 * uses it to record the `*.pages.dev` link; the later `--github` flow reuses it
 * for the remote. The CRM record is never a stage output, so this survives resume.
 */
export function recordSiteVersion(clientJsonPath: string, ref: SiteVersionRef): Client {
  const client = readClient(clientJsonPath);
  if (!client) {
    throw new UserError(`cannot record Site Version: no client.json at ${clientJsonPath}`);
  }
  const existing = client.sites.find((s) => s.version === ref.version);
  const merged: SiteVersionRef = existing ? { ...existing, ...ref } : ref;
  const sites = [...client.sites.filter((s) => s.version !== ref.version), merged].sort(
    (a, b) => a.version - b.version,
  );
  const next: Client = { ...client, sites };
  writeClient(clientJsonPath, next);
  return next;
}

/**
 * Uniqueness guard: refuses to create a Client when one already exists at the
 * slug. `build` is for new Clients; continuing an existing one uses
 * `resume`/`variant` (ADR-0002).
 */
export function createClient(paths: ClientPaths, inputs: ClientInputs): Client {
  if (existsSync(paths.clientJson)) {
    throw new UserError(
      `a Client already exists at "${paths.slug}"`,
      `use \`sb resume ${paths.name}\` to continue it, or \`sb variant\` for a new Site Version`,
    );
  }
  const client = newClient(paths.name, inputs);
  writeClient(paths.clientJson, client);
  return client;
}
