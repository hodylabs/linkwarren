import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ClicksChart } from "./ClicksChart";

const series = [
  { bucket: "2026-11-18", qr: 1, typed: 2 },
  { bucket: "2026-11-19", qr: 3, typed: 4 },
  { bucket: "2026-11-20", qr: 1200, typed: 84 },
];
const tip = () => screen.getByRole("status").textContent;
const tipBox = () => document.querySelector(".tip")!;

describe("ClicksChart", () => {
  it("titles the card with the first and last day and shows the legend", () => {
    render(<ClicksChart series={series} unit="day" table={false} onToggle={() => {}} />);
    expect(screen.getByRole("heading", { name: "Clicks per day, Nov 18 to Nov 20" })).toBeTruthy();
    expect(screen.getByText("From QR codes")).toBeTruthy();
    expect(screen.getByText("Typed or clicked")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Clicks over time split into QR scans and typed or clicked visits" })).toBeTruthy();
  });

  it("hourly title", () => {
    render(<ClicksChart series={[{ bucket: "2026-11-20T10:00:00Z", qr: 1, typed: 0 }]} unit="hour" table={false} onToggle={() => {}} />);
    expect(screen.getByRole("heading", { name: "Clicks per hour, last 24 hours" })).toBeTruthy();
  });

  it("hovering a bar shows its tip, leaving hides it", () => {
    const { container } = render(<ClicksChart series={series} unit="day" table={false} onToggle={() => {}} />);
    const bar = container.querySelectorAll(".bar")[1]!;
    fireEvent.mouseMove(bar, { clientX: 10, clientY: 10 });
    expect(tip()).toBe("Nov 19: 7 clicks, 3 from QR, 4 typed or clicked");
    expect(tipBox().classList.contains("on")).toBe(true);
    fireEvent.mouseLeave(bar);
    expect(tipBox().classList.contains("on")).toBe(false);
  });

  it("focus then ArrowRight twice shows the third bar; Home, End and Esc", async () => {
    const user = userEvent.setup();
    render(<ClicksChart series={series} unit="day" table={false} onToggle={() => {}} />);
    await user.tab(); // the Table view button
    await user.tab();
    const wrap = screen.getByRole("group", { name: /Clicks chart/ });
    expect(document.activeElement).toBe(wrap);
    expect(tip()).toBe("Nov 18: 3 clicks, 1 from QR, 2 typed or clicked");
    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(tip()).toBe("Nov 20: 1,284 clicks, 1,200 from QR, 84 typed or clicked");
    await user.keyboard("{ArrowRight}");
    expect(tip()).toBe("Nov 20: 1,284 clicks, 1,200 from QR, 84 typed or clicked");
    await user.keyboard("{Home}");
    expect(tip()).toBe("Nov 18: 3 clicks, 1 from QR, 2 typed or clicked");
    await user.keyboard("{End}");
    expect(tip()).toContain("Nov 20");
    await user.keyboard("{Escape}");
    expect(tipBox().classList.contains("on")).toBe(false);
  });

  it("ArrowLeft after the series shrank moves from the last bar, not from a bar that is gone", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ClicksChart series={series} unit="day" table={false} onToggle={() => {}} />);
    await user.tab();
    await user.tab();
    await user.keyboard("{End}");
    rerender(<ClicksChart series={series.slice(0, 2)} unit="day" table={false} onToggle={() => {}} />);
    await user.keyboard("{ArrowLeft}");
    expect(tip()).toBe("Nov 18: 3 clicks, 1 from QR, 2 typed or clicked");
  });

  it("the announced tip is a separate, always rendered status (the visual tip is hidden from the tree)", () => {
    render(<ClicksChart series={series} unit="day" table={false} onToggle={() => {}} />);
    const status = screen.getByRole("status");
    expect(status.classList.contains("sr-only")).toBe(true);
    expect(status.textContent).toBe("");
    expect(tipBox().getAttribute("aria-hidden")).toBe("true");
  });

  it("switching to the table while the chart has focus moves focus to the view toggle", () => {
    const { rerender } = render(<ClicksChart series={series} unit="day" table={false} onToggle={() => {}} />);
    screen.getByRole("group", { name: /Clicks chart/ }).focus();
    rerender(<ClicksChart series={series} unit="day" table onToggle={() => {}} />);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Chart view/ }));
  });

  it("a custom empty line replaces the default one", () => {
    render(<ClicksChart series={[]} unit="hour" table={false} onToggle={() => {}} empty="Hourly clicks need live clicks." />);
    expect(screen.getByText("Hourly clicks need live clicks.")).toBeTruthy();
  });

  it("table view has four columns and the same totals; the toggle button calls onToggle", async () => {
    const onToggle = vi.fn();
    render(<ClicksChart series={series} unit="day" table onToggle={onToggle} />);
    const t = screen.getByRole("table");
    expect(within(t).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Day", "From QR", "Typed or clicked", "Total"]);
    const rows = within(t).getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell").map((c) => c.textContent));
    expect(rows).toEqual([["Nov 18", "1", "2", "3"], ["Nov 19", "3", "4", "7"], ["Nov 20", "1,200", "84", "1,284"]]);
    await userEvent.setup().click(screen.getByRole("button", { name: /Chart view/ }));
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("hourly table header is Hour", () => {
    render(<ClicksChart series={[{ bucket: "2026-11-20T10:00:00Z", qr: 1, typed: 0 }]} unit="hour" table onToggle={() => {}} />);
    expect(screen.getAllByRole("columnheader")[0]!.textContent).toBe("Hour");
  });

  it("no clicks shows the empty copy and no chart", () => {
    render(<ClicksChart series={[{ bucket: "2026-11-20", qr: 0, typed: 0 }]} unit="day" table={false} onToggle={() => {}} />);
    expect(screen.getByText("No clicks match these filters. Try a longer range or another domain.")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
  });
});
