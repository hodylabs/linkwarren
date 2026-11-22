/** Many-link selection on the Links list (pure). `anchor` is where a Shift range starts. */
export type Sel = { ids: ReadonlySet<string>; anchor: string | null };

export const EMPTY_SEL: Sel = { ids: new Set(), anchor: null };

export const clear = (): Sel => EMPTY_SEL;

export function toggle(s: Sel, id: string): Sel {
  const ids = new Set(s.ids);
  if (!ids.delete(id)) ids.add(id);
  return { ids, anchor: id };
}

/** Adds anchor..to (inclusive, either direction). With no loaded anchor it selects just `to` and anchors there. */
export function range(s: Sel, order: readonly string[], to: string): Sel {
  const a = s.anchor === null ? -1 : order.indexOf(s.anchor);
  const b = order.indexOf(to);
  if (a < 0 || b < 0) return { ids: new Set([...s.ids, to]), anchor: to };
  return { ids: new Set([...s.ids, ...order.slice(Math.min(a, b), Math.max(a, b) + 1)]), anchor: s.anchor };
}

/** Shift+J/K: adds the cursor and the next row that way, and moves the cursor there (it stays put at a list end). No cursor: starts at the first or last row. */
export function extend(s: Sel, order: readonly string[], cursor: string, step: 1 | -1): { sel: Sel; cursor: string } {
  const i = order.indexOf(cursor);
  const to = i < 0 ? order[step === 1 ? 0 : order.length - 1] : (order[i + step] ?? cursor);
  if (to === undefined) return { sel: s, cursor };
  const ids = new Set(s.ids);
  if (i >= 0) ids.add(cursor);
  ids.add(to);
  return { sel: { ids, anchor: s.anchor ?? (i >= 0 ? cursor : to) }, cursor: to };
}

export const all = (order: readonly string[]): Sel => ({ ids: new Set(order), anchor: null });

/** Drops ids that are no longer loaded. Returns `s` itself when nothing changes. */
export function keepOnly(s: Sel, loaded: ReadonlySet<string>): Sel {
  if ([...s.ids].every((id) => loaded.has(id)) && (s.anchor === null || loaded.has(s.anchor))) return s;
  return { ids: new Set([...s.ids].filter((id) => loaded.has(id))), anchor: s.anchor !== null && loaded.has(s.anchor) ? s.anchor : null };
}
