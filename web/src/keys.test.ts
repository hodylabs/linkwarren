import { fireEvent, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { isTypingTarget, useHotkeys } from "./keys";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  document.body.append(e);
  return e;
}

describe("isTypingTarget", () => {
  it.each([
    ["text input", () => el("input")],
    ["search input", () => el("input", { type: "search" })],
    ["textarea", () => el("textarea")],
    ["select", () => el("select")],
    ["contenteditable", () => el("div", { contenteditable: "true" })],
    ["child of contenteditable", () => el("div", { contenteditable: "" }).appendChild(document.createElement("span"))],
  ])("true for %s", (_, make) => expect(isTypingTarget(make())).toBe(true));
  it.each([
    ["checkbox", () => el("input", { type: "checkbox" })],
    ["radio", () => el("input", { type: "radio" })],
    ["button", () => el("button")],
    ["input type=button", () => el("input", { type: "button" })],
    ["body", () => document.body],
    ["contenteditable=false", () => el("div", { contenteditable: "false" })],
  ])("false for %s", (_, make) => expect(isTypingTarget(make())).toBe(false));
  it("false for null", () => expect(isTypingTarget(null)).toBe(false));
});

describe("useHotkeys", () => {
  const press = (target: Element, init: KeyboardEventInit) => fireEvent.keyDown(target, init);

  it("fires n with focus on body, not inside a text input", () => {
    const n = vi.fn();
    renderHook(() => useHotkeys({ n }));
    press(document.body, { key: "n" });
    expect(n).toHaveBeenCalledTimes(1);
    const input = el("input");
    input.focus();
    press(input, { key: "n" });
    expect(n).toHaveBeenCalledTimes(1);
  });

  it("escape, mod+enter, mod+shift+enter, mod+k and alt keys fire inside an input", () => {
    const h = { escape: vi.fn(), "mod+enter": vi.fn(), "mod+shift+enter": vi.fn(), "mod+k": vi.fn(), "alt+d": vi.fn() };
    renderHook(() => useHotkeys(h));
    const input = el("input");
    press(input, { key: "Escape" });
    press(input, { key: "Enter", ctrlKey: true });
    press(input, { key: "Enter", metaKey: true, shiftKey: true });
    press(input, { key: "k", ctrlKey: true });
    press(input, { key: "∂", code: "KeyD", altKey: true }); // Alt+D on a Mac layout
    expect(h.escape).toHaveBeenCalledTimes(1);
    expect(h["mod+enter"]).toHaveBeenCalledTimes(1);
    expect(h["mod+shift+enter"]).toHaveBeenCalledTimes(1);
    expect(h["mod+k"]).toHaveBeenCalledTimes(1);
    expect(h["alt+d"]).toHaveBeenCalledTimes(1);
  });

  it("mod+shift+enter does not fall back to mod+enter", () => {
    const h = { "mod+enter": vi.fn() };
    renderHook(() => useHotkeys(h));
    press(document.body, { key: "Enter", ctrlKey: true, shiftKey: true });
    expect(h["mod+enter"]).not.toHaveBeenCalled();
  });

  it("Shift+N fires n; Shift+D fires shift+d and not d when both are bound", () => {
    const h = { n: vi.fn(), d: vi.fn(), "shift+d": vi.fn() };
    renderHook(() => useHotkeys(h));
    press(document.body, { key: "N", shiftKey: true });
    press(document.body, { key: "D", shiftKey: true });
    expect(h.n).toHaveBeenCalledTimes(1);
    expect(h["shift+d"]).toHaveBeenCalledTimes(1);
    expect(h.d).not.toHaveBeenCalled();
  });

  it("? fires on Shift+/ and letters are case-insensitive", () => {
    const h = { "?": vi.fn(), j: vi.fn() };
    renderHook(() => useHotkeys(h));
    press(document.body, { key: "?", shiftKey: true });
    press(document.body, { key: "J" });
    expect(h["?"]).toHaveBeenCalledTimes(1);
    expect(h.j).toHaveBeenCalledTimes(1);
  });

  it("ignores composing events and plain keys with Ctrl held", () => {
    const n = vi.fn();
    renderHook(() => useHotkeys({ n }));
    press(document.body, { key: "n", isComposing: true });
    press(document.body, { key: "n", ctrlKey: true });
    expect(n).not.toHaveBeenCalled();
  });

  it("does nothing when disabled and stops listening on unmount", () => {
    const n = vi.fn();
    const { rerender, unmount } = renderHook(({ on }) => useHotkeys({ n }, on), { initialProps: { on: false } });
    press(document.body, { key: "n" });
    rerender({ on: true });
    press(document.body, { key: "n" });
    unmount();
    press(document.body, { key: "n" });
    expect(n).toHaveBeenCalledTimes(1);
  });
});
