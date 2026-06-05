// Design imagery for the Kit. Astro optimizes these to WebP at build time
// via `astro:assets`. Replace these files with client-specific imagery during
// the generate stage, keeping the same export names.

// Photos.
export { default as hero } from "./hero.png";
// Logo mark — one file, transparent background.
// Nav uses it as-is (colored mark on white). Footer applies brightness-0 invert to flip it white.
export { default as logo } from "./logo.png";
export { default as team } from "./team.png";
