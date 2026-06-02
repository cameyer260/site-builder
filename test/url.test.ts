import { expect, test } from "bun:test";
import { isPageWorthy, normalizeUrl, pageSlug, sameOrigin } from "../src/ingest/url.ts";

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

test("pageSlug derives a filesystem stem", () => {
  expect(pageSlug("https://x.com/")).toBe("index");
  expect(pageSlug("https://x.com/about-us")).toBe("about-us");
  expect(pageSlug("https://x.com/blog/post/1")).toBe("blog-post-1");
});
