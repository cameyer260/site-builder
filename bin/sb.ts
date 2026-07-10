#!/usr/bin/env bun
import { main } from "../src/cli.ts";
import { killActiveEngines } from "../src/engine/runner.ts";

// Engines are spawned detached in their own process group (ADR-0001), so the
// terminal's Ctrl+C is delivered to sb only, never to the engine — without this,
// cancelling a build orphans the engine subprocess to keep running standalone.
// First signal reaps in-flight engines and exits with the conventional
// signal-based code; a second (impatient) signal force-exits immediately.
let shuttingDown = false;
function handleSignal(signal: NodeJS.Signals): void {
  if (shuttingDown) {
    process.exit(1);
  }
  shuttingDown = true;
  void killActiveEngines(`sb received ${signal}`).then(() => {
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
}
process.on("SIGINT", () => handleSignal("SIGINT"));
process.on("SIGTERM", () => handleSignal("SIGTERM"));

process.exit(await main(process.argv.slice(2)));
