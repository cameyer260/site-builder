import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import pc from "picocolors";

/**
 * Minimal leveled logger. Writes a colorized line to the console and, when a
 * `file` is given, appends a plain timestamped line to `<client>/logs/…`.
 * Logging must never throw and take down a pipeline run.
 */
export interface Logger {
  info(msg: string): void;
  step(msg: string): void;
  success(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

type Level = "info" | "step" | "success" | "warn" | "error";

const decorate: Record<Level, (s: string) => string> = {
  info: (s) => pc.dim(s),
  step: (s) => `${pc.cyan("›")} ${s}`,
  success: (s) => `${pc.green("✓")} ${s}`,
  warn: (s) => `${pc.yellow("!")} ${s}`,
  error: (s) => `${pc.red("✗")} ${s}`,
};

export function createLogger(opts: { file?: string; quiet?: boolean } = {}): Logger {
  const { file, quiet = false } = opts;
  if (file) {
    mkdirSync(dirname(file), { recursive: true });
  }

  const emit = (level: Level, msg: string): void => {
    if (!quiet) {
      const out = level === "error" || level === "warn" ? console.error : console.log;
      out(decorate[level](msg));
    }
    if (file) {
      try {
        appendFileSync(file, `${new Date().toISOString()} [${level}] ${msg}\n`);
      } catch {
        // never let logging failures crash the run
      }
    }
  };

  return {
    info: (m) => emit("info", m),
    step: (m) => emit("step", m),
    success: (m) => emit("success", m),
    warn: (m) => emit("warn", m),
    error: (m) => emit("error", m),
  };
}
