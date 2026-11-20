import { describe, expect, it } from "vitest";

import { safeNextPath } from "../src/lib/auth-shared";

describe("safeNextPath", () => {
  it.each([
    ["/", "/"],
    ["/jobs", "/jobs"],
    ["/jobs?status=CREATED#top", "/jobs?status=CREATED#top"],
  ])("keeps the same-origin path %s", (next, expected) => {
    expect(safeNextPath(next)).toBe(expected);
  });

  it.each([
    ["a protocol-relative URL", "//evil.example"],
    ["a backslash URL", "/\\evil.example"],
    ["a tab the browser strips", "/\t/evil.example"],
    ["a newline the browser strips", "/\n/evil.example"],
    ["an absolute URL", "https://evil.example"],
    ["a javascript: URL", "javascript:alert(1)"],
    ["an empty string", ""],
    ["an array", ["/jobs"]],
    ["undefined", undefined],
  ])("falls back to / for %s", (_, next) => {
    expect(safeNextPath(next)).toBe("/");
  });
});
