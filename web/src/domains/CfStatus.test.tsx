import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { CfView } from "../api";
import { errorText } from "../copy";
import { AppContext, type AppState } from "../state";
import { CfStatus } from "./CfStatus";

const OUT: CfView = {
  kind: "outside", dns: "missing", ownership: "pending", certificate: "pending", errors: [], lastError: null, checkedAt: 1, securityLevel: null, rateLimit: null,
  instructions: { type: "CNAME", name: "go", target: "edge.example.net", apex: false }, attachOnApproval: false, attached: true,
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

  it("account certificate is green only once a check confirmed it", () => {
    show({ ...ACC, certificate: "unknown", lastError: "cloudflare_error" });
    expect(text()).toContain("Certificate not checked yet");
    expect(text()).not.toContain("Covered by your zone's certificate");
  });

  it("unknown DNS promises a retry only while checks continue", () => {
    show({ ...OUT, dns: "unknown", lastError: "cloudflare_forbidden" });
    expect(text()).toContain("Could not check DNS");
    expect(text()).not.toContain("Retrying.");
    cleanup();
    show({ ...OUT, dns: "unknown", lastError: "cloudflare_unreachable" });
    expect(text()).toContain("Could not check DNS right now. Retrying.");
  });

  it("lastError and Cloudflare errors show as plain text", () => {
    show({ ...OUT, lastError: "cloudflare_unreachable", errors: ["<b>txt</b> record missing"] });
    expect(text()).toContain("Cloudflare did not answer. Retrying.");
    expect(screen.getByText("<b>txt</b> record missing")).toBeTruthy();
    expect(document.querySelector("b")).toBeNull();
  });

  it.each<[string, string]>([
    ["cloudflare_unreachable", "Cloudflare did not answer. Retrying."],
    ["cloudflare_error", "Cloudflare answered with an error. Retrying."],
    ["cloudflare_forbidden", errorText("cloudflare_forbidden")],
    ["outside_not_configured", errorText("outside_not_configured")],
    ["route_in_use", errorText("route_in_use")],
    ["hostname_in_use", errorText("hostname_in_use")],
    ["hostname_limit", errorText("hostname_limit")],
    ["internal_error", errorText("internal_error")],
  ])("stored %s shows its own text", (code, line) => {
    show({ ...OUT, lastError: code });
    expect(text()).toContain(line);
    expect(text().includes("Retrying")).toBe(code === "cloudflare_unreachable" || code === "cloudflare_error");
    expect(text()).not.toContain("Something went wrong (");
  });

  it("an account domain whose attach failed says to finish connecting, not Retrying", () => {
    show({ ...ACC, attached: false, ownership: "pending", dns: "missing", lastError: "cloudflare_error" });
    expect(text()).toContain("Not connected to Cloudflare yet");
    expect(text()).toContain("Use Finish connecting to try again.");
    expect(text()).not.toContain("Retrying");
  });

  it("the settled outcome sits in a polite live region that exists before it fills", () => {
    show(OUT);
    const live = document.querySelector('[aria-live="polite"]')!;
    expect(live.textContent).toBe("");
    cleanup();
    show({ ...OUT, dns: "found", ownership: "verified", certificate: "issued" });
    expect(document.querySelector('[aria-live="polite"]')!.textContent).toBe("Record found, ownership verified. Certificate issued by Cloudflare.");
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
