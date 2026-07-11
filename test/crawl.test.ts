import { expect, test } from "bun:test";
import { prioritizePages } from "../src/ingest/crawl.ts";

const CORE = [
  "https://x.com/",
  "https://x.com/about",
  "https://x.com/services",
  "https://x.com/contact",
];
const BLOG = [
  "https://x.com/2025/09/04/a",
  "https://x.com/2025/08/26/b",
  "https://x.com/2025/07/24/c",
  "https://x.com/blog/d",
];

test("prioritizePages keeps all core pages and caps blog posts at blogCap", () => {
  // Blog posts listed first (as a sitemap often does) must not crowd out core.
  const out = prioritizePages([...BLOG, ...CORE], 25, 2);
  expect(out).toEqual([...CORE, BLOG[0] as string, BLOG[1] as string]);
});

test("prioritizePages honors a tuned blogCap", () => {
  expect(prioritizePages([...BLOG, ...CORE], 25, 0)).toEqual(CORE);
  expect(prioritizePages([...BLOG, ...CORE], 25, 4)).toEqual([...CORE, ...BLOG]);
});

test("prioritizePages respects the overall cap, core first", () => {
  const out = prioritizePages([...BLOG, ...CORE], 3, 2);
  expect(out).toEqual(CORE.slice(0, 3));
});

test("prioritizePages returns core untouched when there are no blog posts", () => {
  expect(prioritizePages(CORE, 25, 2)).toEqual(CORE);
});
