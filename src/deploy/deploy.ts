import { join } from "node:path";
import { buildSite, ensureBuiltDist, type SiteBuilder } from "../astro/run.ts";
import type { Config } from "../config/schema.ts";
import { recordSiteVersion } from "../storage/client.ts";
import type { ClientPaths } from "../storage/layout.ts";
import { UserError } from "../util/errors.ts";
import type { Logger } from "../util/log.ts";
import { type DeployRunner, deployToCloudflarePages, pagesProjectName } from "./wrangler.ts";

/**
 * The real `deploy` stage (ADR-0004) — v1's core promise:
 * Inputs → shareable live link. It ensures the Site Version has a built `dist/`,
 * Direct-Uploads it to Cloudflare Pages via Wrangler, and records the returned
 * `*.pages.dev` URL on the Client's Site Version pointer. Pure code: no AI, no
 * GitHub. The wrangler upload is behind an injectable seam (`RunContext.deploySite`)
 * so tests never shell out; the compile gate is the same injected `buildSite`.
 */

const DIST_DIRNAME = "dist";

export interface DeployParams {
  paths: ClientPaths;
  config: Config;
  version: number;
  log: Logger;
  /** Injected compile gate (tests stub it); defaults to install + `astro build`. */
  buildSite?: SiteBuilder;
  /** Injected upload runner (tests stub it); defaults to the real wrangler one. */
  deploy?: DeployRunner;
}

/** Publishes the Site Version and returns its `*.pages.dev` URL. */
export async function runDeploy(params: DeployParams): Promise<string> {
  const { paths, config, version, log } = params;
  const compile = params.buildSite ?? buildSite;
  const deploy = params.deploy ?? deployToCloudflarePages;

  const versionDir = paths.versionDir(version);
  const distDir = join(versionDir, DIST_DIRNAME);

  // 1. Ensure there is a built dist to upload (kept from audit on a normal run;
  //    rebuilt here if a standalone resume at deploy lost it).
  await ensureBuiltDist({
    versionDir,
    compile,
    log,
    buildingMessage: "deploy: building Site before upload (no dist found)",
    failureMessage: "deploy: astro build failed — nothing to upload",
  });

  // 2. Direct Upload to Cloudflare Pages (ADR-0004).
  const projectName = pagesProjectName(paths.slug);
  const result = await deploy({
    siteDir: versionDir,
    distDir,
    projectName,
    wranglerBin: config.wranglerBin,
    log,
  });
  if (!result.ok) {
    throw new UserError("deploy: wrangler pages deploy failed", result.output.trim().slice(-1500));
  }
  if (!result.url) {
    throw new UserError(
      "deploy: published, but could not determine the *.pages.dev URL from wrangler output",
      result.output.trim().slice(-1500),
    );
  }

  // 3. Record the shareable link on the Client's Site Version pointer (ADR-0003).
  recordSiteVersion(paths.clientJson, { version, deployUrl: result.url });
  log.success(`deploy: published Site v${version} → ${result.url}`);
  return result.url;
}
