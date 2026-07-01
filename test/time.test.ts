import { expect, test } from "bun:test";
import { formatUserDateTime } from "../src/util/time.ts";

test("formatUserDateTime renders a local date/time string without raw UTC syntax", () => {
  const formatted = formatUserDateTime("2026-01-02T03:04:00.000Z", {
    locale: "en-US",
    timeZone: "America/New_York",
  });

  expect(formatted).toBe("Jan 1, 2026, 10:04 PM");
  expect(formatted).not.toContain("T03:04:00.000Z");
});

test("formatUserDateTime leaves invalid timestamps unchanged", () => {
  expect(formatUserDateTime("not-a-date")).toBe("not-a-date");
});
