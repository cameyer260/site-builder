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
 * Folds freshly passed Inputs into an existing Client's record (the `sb build
 * --refresh` / re-passed-inputs path, ADR-0002/0008). Scalar Inputs (`url`,
 * `notes`) override when provided; list Inputs (`docs`, `images`) union without
 * duplicates. Passing no new Inputs is a no-op — a bare `--refresh` re-crawls the
 * Client's existing Inputs. Returns the merged Client.
 */
export function mergeClientInputs(clientJsonPath: string, incoming: ClientInputs): Client {
  const client = readClient(clientJsonPath);
  if (!client) {
    throw new UserError(`cannot merge Inputs: no client.json at ${clientJsonPath}`);
  }
  const union = (existing: string[], next: string[]): string[] => [
    ...existing,
    ...next.filter((v) => !existing.includes(v)),
  ];
  const inputs: ClientInputs = {
    url: incoming.url ?? client.inputs.url,
    notes: incoming.notes ?? client.inputs.notes,
    docs: union(client.inputs.docs, incoming.docs),
    images: union(client.inputs.images, incoming.images),
  };
  const next: Client = { ...client, inputs };
  writeClient(clientJsonPath, next);
  return next;
}

/**
 * The CRM fields `sb set` may write on `client.json` (ADR-0003 — facts split
 * from machine state). Dotted keys mirror the schema; arrays (`socials`,
 * `reviews`, `docs`, `images`) are left to `sb edit`. `url` and `notes` map onto
 * the Input record. Every write is re-validated by {@link writeClient}.
 */
export const CLIENT_FIELD_KEYS = [
  "name",
  "contact.name",
  "contact.email",
  "contact.phone",
  "notes",
  "url",
] as const;
export type ClientFieldKey = (typeof CLIENT_FIELD_KEYS)[number];

export function isClientFieldKey(key: string): key is ClientFieldKey {
  return (CLIENT_FIELD_KEYS as readonly string[]).includes(key);
}

/** Sets one scalar CRM field on the Client record and persists it. */
export function setClientField(clientJsonPath: string, key: string, value: string): Client {
  if (!isClientFieldKey(key)) {
    throw new UserError(
      `unknown client field: ${key}`,
      `settable fields: ${CLIENT_FIELD_KEYS.join(", ")} (edit arrays with \`sb edit\`)`,
    );
  }
  const client = readClient(clientJsonPath);
  if (!client) {
    throw new UserError(`no client.json at ${clientJsonPath}`);
  }
  const next: Client = structuredClone(client);
  switch (key) {
    case "name":
      next.name = value;
      break;
    case "contact.name":
      next.contact.name = value;
      break;
    case "contact.email":
      next.contact.email = value;
      break;
    case "contact.phone":
      next.contact.phone = value;
      break;
    case "notes":
      next.notes = value;
      break;
    case "url":
      next.inputs.url = value;
      break;
  }
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
