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

  it("an older reload answering last does not replace a newer list", async () => {
    const answers: ((items: { id: string }[]) => void)[] = [];
    vi.stubGlobal("fetch", async (input: string) =>
      input === "/api/domains"
        ? new Promise((r) => answers.push((items) => r(new Response(JSON.stringify(items), { status: 200 }))))
        : new Response(JSON.stringify({ items: [] }), { status: 200 }),
    );
    function Ids() {
      const { domains, reloadDomains } = useApp();
      return (
        <>
          <output data-testid="ids">{domains.map((d) => d.id).join(",")}</output>
          <button type="button" onClick={() => void reloadDomains().catch(() => {})}>again</button>
        </>
      );
    }
    render(<AppProvider me={owner}><Ids /></AppProvider>);
    await vi.waitFor(() => expect(answers).toHaveLength(1));
    screen.getByRole("button", { name: "again" }).click();
    await vi.waitFor(() => expect(answers).toHaveLength(2));
    answers[1]!([{ id: "new" }]);
    await vi.waitFor(() => expect(screen.getByTestId("ids").textContent).toBe("new"));
    answers[0]!([{ id: "old" }]);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByTestId("ids").textContent).toBe("new");
  });

  it("a signed-out failure does not set loadError", async () => {
    fakeApi({ "GET /api/domains": () => ({ status: 401, body: { error: "unauthenticated" } }), "GET /api/users": () => ({ body: { items: [] } }) });
    render(<AppProvider me={owner}><Probe /></AppProvider>);
    await vi.waitFor(() => expect(screen.getByTestId("cur").textContent).toBe("null"));
    expect(screen.getByTestId("err").textContent).toBe("null");
  });
});
