/**
 * Error class for expected, user-facing failures (bad input, missing config,
 * unmet preconditions). The CLI prints these as a clean message + optional hint
 * and exits 1, without a stack trace. Anything else is treated as a bug.
 */
export class UserError extends Error {
  readonly hint?: string;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = "UserError";
    this.hint = hint;
  }
}
