import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { CfView } from "../api";
import { AppContext, type AppState } from "../state";
import { CfStatus } from "./CfStatus";

const OUT: CfView = {
  kind: "outside", dns: "missing", ownership: "pending", certificate: "pending", errors: [], lastError: null, checkedAt: 1, securityLevel: null, rateLimit: null,
  instructions: { type: "CNAME", name: "go", target: "edge.example.net", apex: false }, attachOnApproval: false,
};
const ACC: CfView = { ...OUT, kind: "account", dns: "found", ownership: "verified", certificate: "issued", instructions: null };

function show(view: CfView) {
  const announce = vi.fn();
  render(
    <AppContext.Provider value={{ announce } as unknown as AppState}>
      <CfStatus view={view} />
    </AppContext.Provider>,
  );
  return { announce };
}
const text = () => document.body.textContent ?? "";

describe("CfStatus", () => {
  it.each<[Partial<CfView>, string, string]>([
    [{ dns: "found", ownership: "verified", certificate: "issued" }, "Record found, ownership verified", "Certificate issued by Cloudflare"],
    [{ dns: "missing" }, "Waiting for the DNS record", "Certificate pending"],
    [{ dns: "wrong_target" }, "Record points somewhere else", "Certificate pending"],
    [{ dns: "found", ownership: "failed", certificate: "failed" }, "Ownership check failed", "Certificate failed"],
    [{ dns: "unknown" }, "Could not check DNS right now. Retrying.", "Certificate pending"],
  ])("outside %o shows its check and HTTPS text", (o, check, https) => {
    show({ ...OUT, ...o });
    expect(text()).toContain("go → edge.example.net");
    expect(text()).toContain(check);
    expect(text()).toContain(https);
  });

  it("account rows: in your account, zone certificate or not covered", () => {
    show(ACC);
    expect(text()).toContain("In your Cloudflare account");
    expect(text()).toContain("Covered by your zone's certificate");
    expect(screen.queryByRole("button", { name: /Copy/ })).toBeNull();
    cleanup();
    show({ ...ACC, certificate: "not_covered" });
    expect(text()).toContain("Not covered by the free certificate. Add an advanced certificate in Cloudflare");
  });

  it("lastError and Cloudflare errors show as plain text", () => {
    show({ ...OUT, lastError: "cloudflare_unreachable", errors: ["<b>txt</b> record missing"] });
    expect(text()).toContain("Cloudflare did not answer. Retrying.");
    expect(screen.getByText("<b>txt</b> record missing")).toBeTruthy();
    expect(document.querySelector("b")).toBeNull();
  });

  it("apex note only for a bare domain", () => {
    show(OUT);
    expect(text()).not.toContain("This is a bare domain");
    cleanup();
    show({ ...OUT, instructions: { ...OUT.instructions!, name: "@", apex: true } });
    expect(text()).toContain("This is a bare domain. Its DNS provider must support CNAME flattening or an ALIAS record.");
  });

  it("the copy button copies the target with Enter and announces Copied", async () => {
    const user = userEvent.setup();
    const { announce } = show(OUT);
    screen.getByRole("button", { name: /Copy/ }).focus();
    await user.keyboard("{Enter}");
    expect(await navigator.clipboard.readText()).toBe("edge.example.net");
    await vi.waitFor(() => expect(announce).toHaveBeenCalledWith("Copied"));
  });
});
