import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Me, RoleItem } from "../api";
import { customRole, OWNER_ROLE } from "../test/roles";
import { RolePicker } from "./RolePicker";

const owner: Me = { id: "uo", email: "o@example.com", name: null, role: "owner", ...OWNER_ROLE };
const manager: Me = { id: "um", email: "m@example.com", name: null, ...customRole(["links.create", "people.manage"], "Lead") };
const ROLES: RoleItem[] = [
  { id: "owner", name: "Owner", perms: [], builtin: "owner", people: 1 },
  { id: "member", name: "Member", perms: ["links.create", "links.bulk", "domains.own", "keys", "agents"], builtin: "member", people: 3 },
  { id: "hl", name: "Helper", perms: ["links.create"], builtin: null, people: 0 },
];

function Picker({ me, allowOwner = true, onPick }: { me: Me; allowOwner?: boolean; onPick: (id: string) => void }) {
  const [v, setV] = useState("member");
  return <RolePicker value={v} onChange={(id) => (setV(id), onPick(id))} roles={ROLES} me={me} allowOwner={allowOwner} />;
}
const options = () => screen.getAllByRole("option");

describe("RolePicker", () => {
  it("an owner sees every role; arrows move and Enter picks", async () => {
    const onPick = vi.fn();
    render(<Picker me={owner} onPick={onPick} />);
    expect(options().map((o) => o.textContent)).toEqual(["Owner", "Member", "Helper"]);
    expect(screen.getByRole("option", { name: "Member" }).getAttribute("aria-selected")).toBe("true");
    const user = userEvent.setup();
    screen.getByRole("listbox").focus();
    await user.keyboard("{ArrowDown}");
    expect(onPick).not.toHaveBeenCalled(); // moving alone picks nothing
    await user.keyboard("{Enter}");
    expect(onPick).toHaveBeenCalledWith("hl");
    expect(screen.getByRole("option", { name: "Helper" }).getAttribute("aria-selected")).toBe("true");
  });

  it("hides Owner unless allowOwner", () => {
    render(<Picker me={owner} allowOwner={false} onPick={() => undefined} />);
    expect(options().map((o) => o.textContent)).toEqual(["Member", "Helper"]);
  });

  it("a non-owner never sees Owner; a role above them is disabled with the reason and cannot be picked", async () => {
    const onPick = vi.fn();
    render(<Picker me={manager} onPick={onPick} />);
    expect(screen.queryByRole("option", { name: /Owner/ })).toBeNull();
    const m = screen.getByRole("option", { name: /Member/ });
    expect(m.getAttribute("aria-disabled")).toBe("true");
    expect(m.textContent).toContain("Has permissions you do not have");
    expect(screen.getByRole("option", { name: "Helper" }).getAttribute("aria-disabled")).toBeNull();
    const user = userEvent.setup();
    screen.getByRole("listbox").focus();
    await user.keyboard("{ArrowUp}{Enter}"); // onto Member, disabled
    await user.click(m);
    expect(onPick).not.toHaveBeenCalled();
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onPick).toHaveBeenCalledWith("hl");
  });

  it("type-ahead by first letter moves to the role", async () => {
    const onPick = vi.fn();
    render(<Picker me={owner} onPick={onPick} />);
    const user = userEvent.setup();
    screen.getByRole("listbox").focus();
    await user.keyboard("h{Enter}");
    expect(onPick).toHaveBeenCalledWith("hl");
    await user.keyboard("o{Enter}");
    expect(onPick).toHaveBeenLastCalledWith("owner");
  });
});
