import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Me } from "../api";
import { AppProvider, useApp } from "../state";
import { fakeApi } from "../test/fakeApi";
import { OWNER_ROLE } from "../test/roles";
import { YourName } from "./YourName";

const me: Me = { id: "uo", email: "olive@example.com", name: null, role: "owner", ...OWNER_ROLE, authMode: "app" };
const Shown = () => <output>{useApp().me.name ?? "none"}</output>;
afterEach(() => vi.unstubAllGlobals());

describe("YourName", () => {
  it("Enter saves the name and the shell shows it at once; an empty save clears it; Save is off until something changes", async () => {
    const api = fakeApi({
      "GET /api/domains": () => ({ body: [] }),
      "PUT /api/account/name": ({ body }) => ({ body: { name: (body as { name: string }).name.trim() || null } }),
    });
    const user = userEvent.setup();
    render(<AppProvider me={me}><YourName /><Shown /></AppProvider>);
    const field = screen.getByLabelText("Your name");
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    await user.type(field, " Olive {Enter}");
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Olive"));
    await user.clear(field);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("none"));
    expect(api.calls.filter((c) => c.method === "PUT").map((c) => c.body)).toEqual([{ name: " Olive " }, { name: "" }]);
  });
});
