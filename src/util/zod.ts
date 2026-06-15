import type { z } from "zod";

/** Flattens a zod error into a single `path: message; …` line for UserError text. */
export function formatZodError(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}
