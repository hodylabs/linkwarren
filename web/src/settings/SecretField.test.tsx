import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeApi } from "../test/fakeApi";
import { SecretField } from "./SecretField";

const STATUS = { pasteAvailable: true, cf: "missing", resend: "dashboard" } as const;
afterEach(() => vi.unstubAllGlobals());

describe("SecretField", () => {
  it("set by a Worker secret: the status line and no input", () => {
    render(<SecretField name="cf" status="secret" pasteAvailable onSaved={() => {}} />);
    expect(screen.getByText("Set via Worker secret")).toBeTruthy();
    expect(document.querySelector("input")).toBeNull();
  });

  it("missing without pasteAvailable: the wrangler command, no input", () => {
    render(<SecretField name="resend" status="missing" pasteAvailable={false} onSaved={() => {}} />);
    expect(screen.getByText("Missing")).toBeTruthy();
    expect(screen.getByText("npx wrangler secret put RESEND_API_KEY -c wrangler.instance.jsonc")).toBeTruthy();
    expect(screen.getByText(/Pasting here needs the SECRETS_KEY Worker secret/)).toBeTruthy();
    expect(document.querySelector("input")).toBeNull();
  });

  it("Ctrl+Enter saves with PUT, clears the input and never renders the value again", async () => {
    const api = fakeApi({ "PUT /api/settings/secrets/cf": () => ({ body: { ...STATUS, cf: "dashboard" } }) });
    const onSaved = vi.fn();
    const user = userEvent.setup();
    render(<SecretField name="cf" status="missing" pasteAvailable onSaved={onSaved} />);
    const input = screen.getByLabelText("Cloudflare API token") as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.getAttribute("autocomplete")).toBe("new-password");
    expect(screen.getByText("Stored encrypted with this instance's secret key. It is never shown again.")).toBeTruthy();
    await user.click(input);
    await user.keyboard("tok_ABCDEFGHIJKLMNOPQRSTUV{Control>}{Enter}{/Control}");
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ ...STATUS, cf: "dashboard" }));
    expect(api.calls).toEqual([{ method: "PUT", path: "/api/settings/secrets/cf", body: { value: "tok_ABCDEFGHIJKLMNOPQRSTUV" } }]);
    expect(input.value).toBe("");
    expect(document.body.innerHTML).not.toContain("tok_ABCDEFGHIJKLMNOPQRSTUV");
  });

  it("an empty field sends nothing; a refused value shows the copy and the code is not echoed as text", async () => {
    const api = fakeApi({ "PUT /api/settings/secrets/resend": () => ({ status: 400, body: { error: "bad_key" } }) });
    const user = userEvent.setup();
    render(<SecretField name="resend" status="missing" pasteAvailable onSaved={() => {}} />);
    await user.click(screen.getByRole("button", { name: /Save/ }));
    expect(api.calls).toHaveLength(0);
    await user.type(screen.getByLabelText("Resend API key"), "nope");
    await user.click(screen.getByRole("button", { name: /Save/ }));
    expect((await screen.findByRole("alert")).textContent).toContain("re_");
  });

  it("Remove shows only for a dashboard value, asks first, and Enter sends DELETE", async () => {
    const api = fakeApi({ "DELETE /api/settings/secrets/resend": () => ({ body: { ...STATUS, resend: "missing" } }) });
    const onSaved = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<SecretField name="resend" status="missing" pasteAvailable onSaved={onSaved} />);
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    rerender(<SecretField name="resend" status="dashboard" pasteAvailable onSaved={onSaved} />);
    expect(screen.getByText("Set in dashboard")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Remove" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain(
      "Remove the email key? Sign-in links and invites stop until a new key is pasted or set with wrangler secret put. People without a passkey cannot sign in meanwhile.",
    );
    expect(api.calls).toHaveLength(0);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ ...STATUS, resend: "missing" }));
    expect(api.calls.map((c) => c.method)).toEqual(["DELETE"]);
  });

  it("the Cloudflare remove names what stops; Esc and Cancel send nothing", async () => {
    const api = fakeApi({ "DELETE /api/settings/secrets/cf": () => ({ body: STATUS }) });
    const user = userEvent.setup();
    render(<SecretField name="cf" status="dashboard" pasteAvailable onSaved={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.getByRole("dialog").textContent).toContain("Remove the Cloudflare token? Adding, attaching and checking domains stops until a new token is set.");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(screen.getByRole("button", { name: "Remove" }));
    await user.click(screen.getByRole("button", { name: /Cancel/ }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(api.calls).toHaveLength(0);
  });

  it("a dashboard value without pasteAvailable can still be removed, and shows the command", async () => {
    fakeApi({});
    render(<SecretField name="cf" status="dashboard" pasteAvailable={false} onSaved={() => {}} />);
    expect(screen.getByText("npx wrangler secret put CF_API_TOKEN -c wrangler.instance.jsonc")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
  });

  it("Esc clears what was typed", async () => {
    fakeApi({});
    const user = userEvent.setup();
    render(<SecretField name="cf" status="missing" pasteAvailable onSaved={() => {}} />);
    const input = screen.getByLabelText("Cloudflare API token") as HTMLInputElement;
    await user.type(input, "abc{Escape}");
    expect(input.value).toBe("");
  });
});
