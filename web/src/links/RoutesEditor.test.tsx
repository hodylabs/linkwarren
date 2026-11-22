import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import type { Route } from "../api";
import { RoutesEditor } from "./RoutesEditor";

function Harness({ start, seen }: { start: Route[]; seen: Route[][] }) {
  const [v, setV] = useState(start);
  return <RoutesEditor value={v} onChange={(r) => { seen.push(r); setV(r); }} />;
}

describe("RoutesEditor device chips", () => {
  it("groups Device, Phone OS and Computer OS chips in order; each toggles by keyboard and keeps the editor order", async () => {
    const seen: Route[][] = [];
    render(<Harness start={[{ countries: ["CA"], devices: [], url: "https://x.ca/" }]} seen={seen} />);
    const devices = screen.getByRole("group", { name: "Rule 1 devices" });
    const groups = within(devices).getAllByRole("group");
    expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual(["Rule 1 Device", "Rule 1 Phone OS", "Rule 1 Computer OS"]);
    expect(within(devices).getAllByRole("switch").map((s) => s.getAttribute("aria-label"))).toEqual(
      ["Mobile", "Tablet", "Desktop", "iOS", "Android", "Windows", "macOS", "Linux", "ChromeOS"].map((l) => `Rule 1 ${l}`),
    );
    const user = userEvent.setup();
    for (const name of ["Rule 1 Linux", "Rule 1 iOS", "Rule 1 Android", "Rule 1 ChromeOS"]) {
      screen.getByRole("switch", { name }).focus();
      await user.keyboard("{Enter}");
    }
    expect(seen.at(-1)![0]!.devices).toEqual(["ios", "android", "linux", "chromeos"]);
    expect(screen.getByRole("switch", { name: "Rule 1 iOS" }).getAttribute("aria-checked")).toBe("true");
    await user.keyboard(" ");
    expect(seen.at(-1)![0]!.devices).toEqual(["ios", "android", "linux"]);
    expect(screen.getByText(/iPad in desktop mode/)).toBeTruthy();
  });
});
