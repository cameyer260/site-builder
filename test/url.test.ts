import { expect, test } from "bun:test";
import { isBlogUrl, isPageWorthy, normalizeUrl, pageSlug, sameOrigin } from "../src/ingest/url.ts";

test("normalizeUrl resolves, drops hash + trailing slash, rejects non-http", () => {
  expect(normalizeUrl("/about/", "https://x.com/page")).toBe("https://x.com/about");
  expect(normalizeUrl("contact#top", "https://x.com/a/")).toBe("https://x.com/a/contact");
  expect(normalizeUrl("https://x.com/", "https://x.com")).toBe("https://x.com/");
  expect(normalizeUrl("mailto:a@b.com", "https://x.com")).toBeNull();
  expect(normalizeUrl("javascript:void(0)", "https://x.com")).toBeNull();
});

test("sameOrigin compares scheme+host+port", () => {
  expect(sameOrigin("https://x.com/a", "https://x.com/b")).toBe(true);
  expect(sameOrigin("https://cdn.x.com/a", "https://x.com/b")).toBe(false);
  expect(sameOrigin("http://x.com/a", "https://x.com/b")).toBe(false);
});

test("isPageWorthy rejects asset extensions but allows extensionless paths", () => {
  expect(isPageWorthy("https://x.com/about")).toBe(true);
  expect(isPageWorthy("https://x.com/")).toBe(true);
  expect(isPageWorthy("https://x.com/logo.png")).toBe(false);
  expect(isPageWorthy("https://x.com/doc.pdf")).toBe(false);
  expect(isPageWorthy("https://x.com/app.js")).toBe(false);
});

test("isBlogUrl flags date permalinks and blog/archive segments, not core pages", () => {
  // WordPress date permalinks + archives
  expect(isBlogUrl("https://x.com/2025/09/04/repiping-services")).toBe(true);
  expect(isBlogUrl("https://x.com/2025/09")).toBe(true);
  // Blog/news/taxonomy segments, including "blog" inside a compound segment
  expect(isBlogUrl("https://x.com/blog/how-to")).toBe(true);
  expect(isBlogUrl("https://x.com/company-blog/how-to")).toBe(true);
  expect(isBlogUrl("https://x.com/blog-2")).toBe(true);
  expect(isBlogUrl("https://x.com/news")).toBe(true);
  expect(isBlogUrl("https://x.com/category/uncategorized")).toBe(true);
  expect(isBlogUrl("https://x.com/tag/pipes")).toBe(true);
  expect(isBlogUrl("https://x.com/author/amber")).toBe(true);
  // Core pages stay false, including look-alikes ("newsletter" isn't "news")
  expect(isBlogUrl("https://x.com/")).toBe(false);
  expect(isBlogUrl("https://x.com/about")).toBe(false);
  expect(isBlogUrl("https://x.com/services/drain-cleaning")).toBe(false);
  expect(isBlogUrl("https://x.com/newsletter")).toBe(false);
  expect(isBlogUrl("https://x.com/2025-in-review")).toBe(false);
});

test("pageSlug derives a filesystem stem", () => {
  expect(pageSlug("https://x.com/")).toBe("index");
  expect(pageSlug("https://x.com/about-us")).toBe("about-us");
  expect(pageSlug("https://x.com/blog/post/1")).toBe("blog-post-1");
});
