import { describe, expect, it } from "vitest";
import { paletteKey, type Command, type PaletteState } from "./palette";

const cmd = (keys: string): Command => ({ keys, section: "Go to", label: keys, run: () => {} });
const cmds = [cmd("gl"), cmd("gd"), cmd("cl"), cmd("sd"), cmd("?")];
const k = (key: string, over: Partial<{ ctrl: boolean; meta: boolean; alt: boolean; composing: boolean }> = {}) => ({
  key, ctrl: false, meta: false, alt: false, composing: false, ...over,
});
const press = (s: PaletteState, key: string, over = {}) => paletteKey(s, k(key, over), cmds);
const empty: PaletteState = { buf: "", text: "" };

describe("paletteKey", () => {
  it("g buffers, then l runs gl", () => {
    const a = press(empty, "g");
    expect(a).toMatchObject({ s: { buf: "g", text: "" }, consumed: true });
    expect(a.run).toBeUndefined();
    const b = press(a.s, "l");
    expect(b.run?.keys).toBe("gl");
    expect(b.s).toEqual({ buf: "", text: "" });
    expect(b.consumed).toBe(true);
  });
  it("g then o falls back to the text go", () => {
    const r = press(press(empty, "g").s, "o");
    expect(r).toMatchObject({ s: { buf: "", text: "go" }, consumed: true });
    expect(r.run).toBeUndefined();
  });
  it("a key that starts nothing is normal typing", () => {
    expect(press(empty, "x").consumed).toBe(false);
  });
  it("upper case matches the same command", () => {
    expect(press(press(empty, "G").s, "D").run?.keys).toBe("gd");
  });
  it("Backspace with a buffer drops one buffered letter", () => {
    const r = press({ buf: "g", text: "" }, "Backspace");
    expect(r).toMatchObject({ s: { buf: "", text: "" }, consumed: true });
    expect(press(empty, "Backspace").consumed).toBe(false);
    expect(press({ buf: "", text: "ab" }, "Backspace").consumed).toBe(false);
  });
  it("Ctrl, Alt, Meta and composing never consume", () => {
    for (const over of [{ ctrl: true }, { alt: true }, { meta: true }, { composing: true }]) {
      expect(press(empty, "g", over).consumed).toBe(false);
      expect(press({ buf: "g", text: "" }, "l", over).consumed).toBe(false);
    }
  });
  it("with text already typed nothing is consumed", () => {
    expect(press({ buf: "", text: "x" }, "g").consumed).toBe(false);
  });
  it("named keys are not printable", () => {
    expect(press(empty, "Enter").consumed).toBe(false);
    expect(press({ buf: "g", text: "" }, "ArrowDown").consumed).toBe(false);
  });
  it("? runs the help command at once", () => {
    expect(press(empty, "?").run?.keys).toBe("?");
  });
});
