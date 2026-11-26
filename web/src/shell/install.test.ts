import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { shouldNudge } from "./install";

describe("shouldNudge", () => {
  it("waits for the second visit, on a phone, when the browser can install", () => {
    expect(shouldNudge("1", "prompt", true)).toBe(false);
    expect(shouldNudge("2", "prompt", true)).toBe(true);
    expect(shouldNudge("9", "ios", true)).toBe(true);
  });
  it("never nudges after Install or Not now, on a wide screen, or when there is nothing to install", () => {
    expect(shouldNudge("done", "prompt", true)).toBe(false);
    expect(shouldNudge("5", "prompt", false)).toBe(false);
    expect(shouldNudge("5", null, true)).toBe(false);
    expect(shouldNudge(null, "prompt", true)).toBe(false);
  });
});

describe("manifest", () => {
  const dir = join(process.cwd(), "web/public");
  const m = JSON.parse(readFileSync(join(dir, "manifest.webmanifest"), "utf8"));
  it("is relative, so path mode keeps short links out of the app's scope", () => {
    for (const k of ["id", "start_url", "scope"]) expect(m[k]).toBe("./");
    for (const i of m.icons) {
      expect(i.src).not.toMatch(/^\/|:/);
      expect(existsSync(join(dir, i.src))).toBe(true);
    }
    expect(m.icons.some((i: { purpose: string }) => i.purpose === "maskable")).toBe(true);
  });
});
