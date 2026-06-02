import { expect, test } from "bun:test";
import { htmlToMarkdown } from "../src/ingest/markdown.ts";

test("htmlToMarkdown converts headings, links, and lists", () => {
  const md = htmlToMarkdown(
    "<h1>Acme</h1><p>We do <a href='https://x.com'>plumbing</a>.</p><ul><li>One</li><li>Two</li></ul>",
  );
  expect(md).toContain("# Acme");
  expect(md).toContain("[plumbing](https://x.com)");
  expect(md).toContain("One");
  expect(md).toContain("Two");
});

test("htmlToMarkdown ignores script and style", () => {
  const md = htmlToMarkdown("<style>.a{color:red}</style><p>hi</p><script>alert(1)</script>");
  expect(md).toContain("hi");
  expect(md).not.toContain("alert");
  expect(md).not.toContain("color:red");
});
