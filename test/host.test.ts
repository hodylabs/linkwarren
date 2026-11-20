import { describe, expect, it } from "vitest";
import { normalizeHost, slugFromPath } from "../src/host";

describe("normalizeHost", () => {
  it.each(["Go.Example.com.", "go.example.com:443", "GO.EXAMPLE.COM"])("%s -> go.example.com", (h) => {
    expect(normalizeHost(h)).toBe("go.example.com");
  });
});

describe("slugFromPath", () => {
  it.each([
    ["/Spring", "Spring"],
    ["/spring/", "spring"],
    ["/%73pring", "spring"],
  ])("%s -> %s", (p, s) => expect(slugFromPath(p)).toBe(s));

  it.each(["/", "", "/a/b", "/%2F", "/%E0%A4%A", "/" + "a".repeat(65)])("%j -> null", (p) => {
    expect(slugFromPath(p)).toBeNull();
  });
});
