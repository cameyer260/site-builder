/**
 * Pure URL helpers for crawling: normalization, same-origin checks, filtering
 * out non-page resources, and deriving a filesystem slug per page.
 */

const SKIP_EXTENSIONS = new Set([
  ".pdf",
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".svg",
  ".ico",
  ".css",
  ".js",
  ".mjs",
  ".json",
  ".xml",
  ".zip",
  ".gz",
  ".mp4",
  ".webm",
  ".mp3",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".rss",
  ".atom",
]);

/** Resolves `href` against `base`, drops the hash and trailing slash, http(s) only. */
export function normalizeUrl(href: string, base: string): string | null {
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }
  url.hash = "";
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }
  return url.toString();
}

export function sameOrigin(url: string, base: string): boolean {
  try {
    return new URL(url).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

/** False for URLs whose extension marks them as a non-HTML resource. */
export function isPageWorthy(url: string): boolean {
  let pathname: string;
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    return false;
  }
  const dot = pathname.lastIndexOf(".");
  const slash = pathname.lastIndexOf("/");
  if (dot > slash) {
    return !SKIP_EXTENSIONS.has(pathname.slice(dot));
  }
  return true;
}

/** A filesystem-safe stem for a page (the path, or "index" for the root). */
export function pageSlug(url: string): string {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return "page";
  }
  const trimmed = pathname.replace(/^\/+|\/+$/g, "");
  if (!trimmed) {
    return "index";
  }
  return (
    trimmed
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "index"
  );
}
