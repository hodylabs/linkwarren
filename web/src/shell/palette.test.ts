import { describe, expect, it } from "vitest";
import type { Me } from "../api";
import { customRole, MEMBER_ROLE, OWNER_ROLE } from "../test/roles";
import { buildCommands, paletteKey, type Command, type PaletteState } from "./palette";

const OWNER: Me = { id: "uo", email: "o@example.com", name: null, role: "owner", ...OWNER_ROLE };
const MEMBER: Me = { id: "um", email: "m@example.com", name: null, role: "member", ...MEMBER_ROLE };

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
  it("keeps the typed case when falling back to text", () => {
    expect(press(press(empty, "G").s, "x").s).toEqual({ buf: "", text: "Gx" });
    expect(press(press(empty, "G").s, "L").run?.keys).toBe("gl");
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

describe("buildCommands: sign-in and security", () => {
  const ctx = { domains: [], open: () => {}, setCurrentDomain: () => {} };
  it("ys exists in app mode only", () => {
    expect(buildCommands(ctx, OWNER, true).find((c) => c.keys === "ys")?.label).toBe("Sign-in and security");
    expect(buildCommands(ctx, OWNER).some((c) => c.keys === "ys")).toBe(false);
    expect(buildCommands(ctx, MEMBER, false).some((c) => c.keys === "ys")).toBe(false);
  });
});

describe("buildCommands: analytics domain filter", () => {
  it("af opens the analytics domain picker for everyone", () => {
    const ctx = { domains: [], open: () => {}, setCurrentDomain: () => {} };
    const af = buildCommands(ctx, MEMBER).find((c) => c.keys === "af")!;
    expect(af).toMatchObject({ section: "Go to", label: "Filter analytics by domain" });
    af.run();
    expect(location.pathname + location.search).toBe("/analytics?pick=1");
  });
});

describe("buildCommands: API & agents", () => {
  const ctx = { domains: [], open: () => {}, setCurrentDomain: () => {} };
  it("gi and ck exist for a member as well as the owner", () => {
    for (const isOwner of [false, true]) {
      const cmds = buildCommands(ctx, isOwner ? OWNER : MEMBER);
      expect(cmds.find((c) => c.keys === "gi")).toMatchObject({ section: "Go to", label: "API & agents" });
      expect(cmds.find((c) => c.keys === "ck")).toMatchObject({ section: "Create", label: "New API key" });
    }
    expect(buildCommands(ctx, MEMBER).some((c) => c.keys === "gp" || c.keys === "gs")).toBe(false);
  });
  it("ck opens the New API key sheet", () => {
    let opened: unknown = null;
    buildCommands({ ...ctx, open: (o) => (opened = o) }, MEMBER).find((c) => c.keys === "ck")!.run();
    expect(opened).toEqual({ kind: "newKey" });
  });
});

describe("buildCommands: follows the role", () => {
  const ctx = { domains: [], open: () => {}, setCurrentDomain: () => {} };
  const keys = (me: Me) => buildCommands(ctx, me).filter((c) => !c.quiet).map((c) => c.keys);
  it("a Member gets exactly today's member commands", () => {
    expect(keys(MEMBER)).toEqual(["gl", "gd", "ga", "af", "gi", "cl", "cd", "ck", "sd", "?"]);
  });
  it("the owner gets every command", () => {
    expect(keys(OWNER)).toEqual(["gl", "gd", "ga", "af", "gi", "gp", "gs", "cl", "cd", "ck", "cp", "sd", "?"]);
  });
  it("a role without create, domains or keys has none of their commands; settings and audit add G S and G P", () => {
    const me: Me = { ...MEMBER, ...customRole(["settings", "audit"]) };
    expect(keys(me)).toEqual(["gl", "gd", "ga", "af", "gi", "gp", "gs", "sd", "?"]);
    expect(buildCommands(ctx, me).filter((c) => c.quiet).length).toBe(7); // Settings: <section>
  });
  it("people.manage adds G P and Invite; domains.manage alone adds Add a domain", () => {
    expect(keys({ ...MEMBER, ...customRole(["people.manage"]) })).toEqual(["gl", "gd", "ga", "af", "gi", "gp", "cp", "sd", "?"]);
    expect(keys({ ...MEMBER, ...customRole(["domains.manage"]) })).toEqual(["gl", "gd", "ga", "af", "gi", "cd", "sd", "?"]);
  });
});
