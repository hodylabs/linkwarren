import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spies = vi.hoisted(() => ({ qrMatrix: vi.fn(), download: vi.fn() }));
vi.mock("./qr", async (orig) => {
  const real = await orig<typeof import("./qr")>();
  spies.qrMatrix.mockImplementation(real.qrMatrix);
  return { ...real, qrMatrix: spies.qrMatrix, download: spies.download };
});
vi.mock("../state", () => ({ useApp: () => ({ announce: vi.fn() }) }));
import { QrPanel } from "./QrPanel";

beforeEach(() => {
  spies.qrMatrix.mockClear();
  spies.download.mockClear();
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ fillRect: vi.fn(), fillStyle: "" })) as never;
  HTMLCanvasElement.prototype.toBlob = function (cb: BlobCallback) {
    cb(new Blob(["png"], { type: "image/png" }));
  };
});

describe("QrPanel", () => {
  it("encodes the short link, never the destination, and labels the image", () => {
    render(<QrPanel host="go.test" slug="spring" />);
    expect(spies.qrMatrix).toHaveBeenCalledWith("https://go.test/spring?lw=qr");
    expect(spies.qrMatrix.mock.calls.flat().join(" ")).not.toContain("dest.test");
    expect(screen.getByRole("img", { name: "QR code for go.test/spring" })).toBeTruthy();
    expect(screen.getByText(/Encodes the short link, so you can change the destination after printing/)).toBeTruthy();
  });

  it("downloads svg and png with the host and slug in the name", async () => {
    const user = userEvent.setup();
    render(<QrPanel host="go.test" slug="spring" />);
    await user.click(screen.getByRole("button", { name: /Download SVG/ }));
    expect(spies.download).toHaveBeenLastCalledWith("go.test-spring.svg", expect.any(Blob));
    await user.click(screen.getByRole("button", { name: /Download PNG/ }));
    await vi.waitFor(() => expect(spies.download).toHaveBeenLastCalledWith("go.test-spring.png", expect.any(Blob)));
  });

  it("re-encodes when the slug changes", () => {
    const { rerender } = render(<QrPanel host="go.test" slug="a" />);
    rerender(<QrPanel host="go.test" slug="b" />);
    expect(spies.qrMatrix).toHaveBeenLastCalledWith("https://go.test/b?lw=qr");
  });
});
