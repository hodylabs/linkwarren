import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { Sheet, useOpenSheets } from "./Sheet";

function Two() {
  const [outer, setOuter] = useState(true);
  const [inner, setInner] = useState(true);
  const open = useOpenSheets();
  return (
    <>
      <output>{open}</output>
      {outer && (
        <Sheet label="Outer" onClose={() => setOuter(false)}>
          <button type="button">outer</button>
        </Sheet>
      )}
      {inner && (
        <Sheet label="Inner" onClose={() => setInner(false)}>
          <button type="button">inner</button>
        </Sheet>
      )}
    </>
  );
}

describe("Sheet stack", () => {
  it("counts open sheets, and each Esc closes only the topmost", async () => {
    const user = userEvent.setup();
    render(<Two />);
    expect(screen.getByRole("status").textContent).toBe("2");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Inner" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Outer" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("1");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("0");
  });
});
