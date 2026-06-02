import { NodeHtmlMarkdown } from "node-html-markdown";

/**
 * Converts rendered page HTML to Markdown for the crawled-site record.
 * node-html-markdown ignores script/style/head and needs no jsdom, so it runs
 * cleanly under Bun. Content selection/cleanup is left to synthesize.
 */
export function htmlToMarkdown(html: string): string {
  return NodeHtmlMarkdown.translate(html).trim();
}
