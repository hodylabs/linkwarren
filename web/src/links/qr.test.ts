import { afterEach, describe, expect, it, vi } from "vitest";
import { download, qrMatrix, qrSvg, qrText, REVOKE_MS } from "./qr";

describe("qr", () => {
  it("encodes the short link with the QR marker", () => {
    expect(qrText("go.test", "spring")).toBe("https://go.test/spring?lw=qr");
  });

  it("builds a square matrix with the three finder frames", () => {
    const m = qrMatrix(qrText("go.test", "spring"));
    const n = m.length;
    expect([25, 29]).toContain(n);
    expect(m.every((r) => r.length === n)).toBe(true);
    const frame = (x: number, y: number) => {
      for (let i = 0; i < 7; i++) {
        for (const [a, b] of [[i, 0], [i, 6], [0, i], [6, i]] as const) expect(m[y + b]![x + a]).toBe(true);
      }
    };
    frame(0, 0);
    frame(n - 7, 0);
    frame(0, n - 7);
  });

  it("renders an svg with a quiet zone and no style attribute", () => {
    const m = qrMatrix("https://go.test/x?lw=qr");
    const svg = qrSvg(m);
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    const el = doc.documentElement;
    expect(el.localName).toBe("svg");
    expect(doc.querySelector("parsererror")).toBeNull();
    expect(el.getAttribute("viewBox")).toBe(`0 0 ${m.length + 8} ${m.length + 8}`);
    expect(el.getAttribute("shape-rendering")).toBe("crispEdges");
    expect(svg).not.toContain("style=");
    expect(doc.querySelector("rect")?.getAttribute("fill")).toBe("#FFFFFF");
    expect(doc.querySelector("path")?.getAttribute("fill")).toBe("#15181D");
  });
});

describe("download", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("clicks a temporary link to an object URL and revokes it only after a delay", () => {
    vi.useFakeTimers();
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fake");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const clicked: { href: string; download: string; attached: boolean }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.href, download: this.download, attached: this.isConnected });
    });
    const blob = new Blob(["x"], { type: "image/svg+xml" });
    download("go.test-spring.svg", blob);
    expect(create).toHaveBeenCalledWith(blob);
    expect(clicked).toEqual([{ href: "blob:fake", download: "go.test-spring.svg", attached: true }]);
    expect(document.querySelector("a[download]")).toBeNull();
    vi.advanceTimersByTime(REVOKE_MS - 1);
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(revoke).toHaveBeenCalledWith("blob:fake");
  });
});
