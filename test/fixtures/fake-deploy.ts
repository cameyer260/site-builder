import type { DeployRunner } from "../../src/deploy/wrangler.ts";

/**
 * Offline stand-in for `deploy`'s Cloudflare Pages upload seam. Returns a
 * deterministic `*.pages.dev` URL (shaped like a real deployment link) without
 * spawning wrangler or touching the network, keeping deploy/pipeline tests fast.
 */
export const fakeDeploy: DeployRunner = async ({ projectName }) => ({
  ok: true,
  url: `https://${projectName}.pages.dev`,
  output: `✨ Deployment complete! Take a peek over at https://a1b2c3.${projectName}.pages.dev`,
});
