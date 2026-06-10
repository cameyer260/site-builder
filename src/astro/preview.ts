import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import type { Logger } from "../util/log.ts";

/**
 * `astro preview` server lifecycle for a built Site Version. `audit` serves the
 * freshly built `dist/` locally so it can be screenshotted, scanned (axe-core,
 * broken links), and measured (Lighthouse) — the same Astro the `generate`
 * compile gate produced, just served. Lives beside `run.ts` as a shared astro/
 * helper. Spawns the Site's own local `astro` binary directly (not via `npm
 * run`) so the server process is the direct child and can be reliably killed.
 */

export interface PreviewServer {
  /** Base URL the static build is served at (e.g. http://127.0.0.1:4321). */
  url: string;
  /** Stops the preview process. Safe to call more than once. */
  stop(): Promise<void>;
}

const HOST = "127.0.0.1";
const READY_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;

/** Asks the OS for an unused TCP port by binding to 0 and reading it back. */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, HOST, () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const { port } = addr;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("could not determine a free port")));
      }
    });
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Starts `astro preview` for the built Site at `siteDir`, on a free port, and
 * resolves once it answers HTTP (or rejects if it exits or never becomes ready).
 * The Site's dependencies must already be installed (the compile gate does that).
 */
export async function startPreview(siteDir: string, log?: Logger): Promise<PreviewServer> {
  const astroBin = join(siteDir, "node_modules", ".bin", "astro");
  if (!existsSync(astroBin)) {
    throw new Error(`astro binary not found at ${astroBin} — install dependencies first`);
  }

  const port = await getFreePort();
  const url = `http://${HOST}:${port}`;

  const child = spawn(astroBin, ["preview", "--host", HOST, "--port", String(port)], {
    cwd: siteDir,
    stdio: ["ignore", "ignore", "pipe"],
  });

  let stderrTail = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-2000);
  });

  let exited = false;
  child.on("exit", () => {
    exited = true;
  });
  // Swallow spawn errors here; the readiness loop below surfaces them.
  child.on("error", () => {
    exited = true;
  });

  const stop = async (): Promise<void> => {
    if (!exited) {
      child.kill("SIGTERM");
    }
  };

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited) {
      throw new Error(
        `astro preview exited before becoming ready${stderrTail ? `: ${stderrTail.trim().slice(-400)}` : ""}`,
      );
    }
    try {
      const res = await fetch(`${url}/`, { signal: AbortSignal.timeout(2000) });
      if (res.status > 0) {
        log?.step(`audit: preview server ready at ${url}`);
        return { url, stop };
      }
    } catch {
      // server not accepting connections yet
    }
    await sleep(POLL_INTERVAL_MS);
  }

  await stop();
  throw new Error(`astro preview did not become ready within ${READY_TIMEOUT_MS}ms`);
}

/** Runs `fn` with a started preview server, always stopping it afterwards. */
export async function withPreview<T>(
  siteDir: string,
  fn: (server: PreviewServer) => Promise<T>,
  log?: Logger,
): Promise<T> {
  const server = await startPreview(siteDir, log);
  try {
    return await fn(server);
  } finally {
    await server.stop();
  }
}
