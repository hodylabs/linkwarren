import { describe, expect, it } from "vitest";
import { all, clear, EMPTY_SEL, extend, keepOnly, range, toggle, type Sel } from "./selection";

const order = ["a", "b", "c", "d", "e"];
const ids = (s: Sel) => [...s.ids].sort();

describe("selection", () => {
  it("toggle adds then removes, and moves the anchor", () => {
    const s1 = toggle(EMPTY_SEL, "b");
    expect(ids(s1)).toEqual(["b"]);
    expect(s1.anchor).toBe("b");
    const s2 = toggle(s1, "b");
    expect(ids(s2)).toEqual([]);
    expect(s2.anchor).toBe("b");
  });

  it("range adds anchor..to inclusive in both directions and keeps the anchor", () => {
    const down = range(toggle(EMPTY_SEL, "b"), order, "d");
    expect(ids(down)).toEqual(["b", "c", "d"]);
    expect(down.anchor).toBe("b");
    const up = range(toggle(EMPTY_SEL, "d"), order, "a");
    expect(ids(up)).toEqual(["a", "b", "c", "d"]);
    expect(up.anchor).toBe("d");
  });

  it("range with no anchor (or one no longer loaded) selects just the target and anchors there", () => {
    const s = range(EMPTY_SEL, order, "c");
    expect(ids(s)).toEqual(["c"]);
    expect(s.anchor).toBe("c");
    const gone = range({ ids: new Set(), anchor: "zz" }, order, "c");
    expect(ids(gone)).toEqual(["c"]);
  });

  it("extend adds the cursor and the next row and moves the cursor", () => {
    const one = extend(EMPTY_SEL, order, "b", 1);
    expect(ids(one.sel)).toEqual(["b", "c"]);
    expect(one.cursor).toBe("c");
    expect(one.sel.anchor).toBe("b");
    const two = extend(one.sel, order, one.cursor, 1);
    expect(ids(two.sel)).toEqual(["b", "c", "d"]);
    const up = extend(EMPTY_SEL, order, "b", -1);
    expect(ids(up.sel)).toEqual(["a", "b"]);
    expect(up.cursor).toBe("a");
  });

  it("extend at the list ends keeps the cursor and only adds it", () => {
    const end = extend(EMPTY_SEL, order, "e", 1);
    expect(ids(end.sel)).toEqual(["e"]);
    expect(end.cursor).toBe("e");
    const top = extend(EMPTY_SEL, order, "a", -1);
    expect(ids(top.sel)).toEqual(["a"]);
    expect(top.cursor).toBe("a");
  });

  it("extend with no cursor starts at the first (down) or last (up) row", () => {
    expect(extend(EMPTY_SEL, order, "", 1)).toEqual({ sel: { ids: new Set(["a"]), anchor: "a" }, cursor: "a" });
    expect(extend(EMPTY_SEL, order, "", -1).cursor).toBe("e");
    expect(extend(EMPTY_SEL, [], "", 1).sel.ids.size).toBe(0);
  });

  it("all selects every id; clear empties", () => {
    expect(ids(all(order))).toEqual(order);
    expect(clear()).toEqual(EMPTY_SEL);
  });

  it("keepOnly drops ids that are not loaded and the anchor with them; unchanged input comes back as is", () => {
    const s = { ids: new Set(["a", "c", "x"]), anchor: "x" };
    const k = keepOnly(s, new Set(order));
    expect(ids(k)).toEqual(["a", "c"]);
    expect(k.anchor).toBeNull();
    const same = { ids: new Set(["a"]), anchor: "a" };
    expect(keepOnly(same, new Set(order))).toBe(same);
  });
});
