import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError, type Me } from "./api";
import { AppProvider, useApp } from "./state";
import { fakeApi } from "./test/fakeApi";

const owner: Me = { id: "uo", email: "owner@example.com", name: null, role: "owner" };

function Probe() {
  const { currentDomainId, loadError, reloadDomains } = useApp();
  return (
    <>
      <output data-testid="cur">{String(currentDomainId)}</output>
      <output data-testid="err">{String(loadError)}</output>
      <button type="button" onClick={() => reloadDomains().catch((e: ApiError) => (document.title = `rejected ${e.code}`))}>reload</button>
    </>
  );
}

describe("AppProvider", () => {
  it("a 500 on the first domains load sets loadError and drops the remembered domain", async () => {
    localStorage.setItem("lw.domain", "d2");
    fakeApi({ "GET /api/domains": () => ({ status: 500, body: { error: "internal" } }), "GET /api/users": () => ({ body: { items: [] } }) });
    render(<AppProvider me={owner}><Probe /></AppProvider>);
    expect(await screen.findByText("Something went wrong (internal)")).toBeTruthy();
    expect(screen.getByTestId("cur").textContent).toBe("null");
  });

  it("a caller of reloadDomains receives the rejection", async () => {
    fakeApi({ "GET /api/domains": () => ({ status: 503, body: { error: "no_assets" } }), "GET /api/users": () => ({ body: { items: [] } }) });
    render(<AppProvider me={owner}><Probe /></AppProvider>);
    await screen.findByText("Something went wrong (no_assets)");
    screen.getByRole("button", { name: "reload" }).click();
    await vi.waitFor(() => expect(document.title).toBe("rejected no_assets"));
  });

  it("a signed-out failure does not set loadError", async () => {
    fakeApi({ "GET /api/domains": () => ({ status: 401, body: { error: "unauthenticated" } }), "GET /api/users": () => ({ body: { items: [] } }) });
    render(<AppProvider me={owner}><Probe /></AppProvider>);
    await vi.waitFor(() => expect(screen.getByTestId("cur").textContent).toBe("null"));
    expect(screen.getByTestId("err").textContent).toBe("null");
  });
});
