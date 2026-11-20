import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("health", () => {
  it("serves /healthz on the dashboard host", async () => {
    const res = await exports.default.fetch("https://dash.test/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("never serves app routes on a short host", async () => {
    const res = await exports.default.fetch("https://short.test/healthz");
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('"ok"');
  });
});
