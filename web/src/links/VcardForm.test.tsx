import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { emptyVcard, type VCard } from "../../../src/vcard";
import { fitSize } from "./photo";
import { cleanVcard, VcardForm, vcardFieldText } from "./VcardForm";

vi.mock("./photo", async (orig) => ({ ...(await orig<typeof import("./photo")>()), resizePhoto: vi.fn(async () => "/9j/AAAA") }));

function Harness({ start = emptyVcard(), field = null, onChange }: { start?: VCard; field?: string | null; onChange?: (v: VCard) => void }) {
  const [v, setV] = useState(start);
  return <VcardForm id="t" value={v} field={field} onChange={(n) => (setV(n), onChange?.(n))} />;
}

describe("VcardForm", () => {
  it("adds and removes phone rows by keyboard: focus goes to the new row, then back to Add", async () => {
    const seen: VCard[] = [];
    const user = userEvent.setup();
    render(<Harness onChange={(v) => seen.push(v)} />);
    screen.getByRole("button", { name: "Add phone" }).focus();
    await user.keyboard("{Enter}");
    expect(document.activeElement).toBe(screen.getByLabelText("Phone 1"));
    await user.keyboard("+1 555 0100");
    await user.selectOptions(screen.getByLabelText("Phone 1 type"), "work");
    expect(seen.at(-1)!.phones).toEqual([{ type: "work", number: "+1 555 0100" }]);
    screen.getByRole("button", { name: "Remove phone 1" }).focus();
    await user.keyboard("{Enter}");
    expect(seen.at(-1)!.phones).toEqual([]);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add phone" }));
  });

  it("stops offering Add at 10 rows", async () => {
    render(<Harness start={{ ...emptyVcard(), emails: new Array(10).fill("a@example.com") }} />);
    expect(screen.queryByRole("button", { name: "Add email" })).toBeNull();
    expect(screen.getByRole("button", { name: "Add website" })).toBeTruthy();
  });

  it("picks a photo (resized in the browser), previews it, and removes it", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    fireEvent.change(screen.getByTestId("vc-file"), { target: { files: [new File(["x"], "me.png", { type: "image/png" })] } });
    const img = (await screen.findByRole("img", { name: "Contact photo" })) as HTMLImageElement;
    expect(img.src).toBe("data:image/jpeg;base64,/9j/AAAA");
    await user.click(screen.getByRole("button", { name: "Remove photo" }));
    expect(screen.queryByRole("img", { name: "Contact photo" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add photo" }));
  });

  it("shows the server's bad field under it and marks the box", () => {
    render(<Harness start={{ ...emptyVcard(), emails: ["x"] }} field="emails.0" />);
    expect(screen.getByRole("alert").textContent).toBe(vcardFieldText("emails.0"));
    expect(screen.getByLabelText("Email 1").getAttribute("aria-invalid")).toBe("true");
  });

  it("cleanVcard drops blank rows; fitSize keeps the aspect and never enlarges", () => {
    expect(cleanVcard({ ...emptyVcard(), phones: [{ type: "cell", number: " " }], emails: ["", "a@example.com"], websites: [""] }))
      .toMatchObject({ phones: [], emails: ["a@example.com"], websites: [] });
    expect(fitSize(1024, 512)).toEqual({ w: 256, h: 128 });
    expect(fitSize(100, 300)).toEqual({ w: 85, h: 256 });
    expect(fitSize(40, 40)).toEqual({ w: 40, h: 40 });
  });
});
