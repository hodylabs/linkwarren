import { useState } from "react";
import { keyLabels } from "../keys";
import { PHONE, useMedia } from "../shell/narrow";
import { Sheet } from "../shell/Sheet";

export type BulkAction = "delete" | "schedule" | "move" | "redirect" | "password" | "copy" | "export";

/** Hotkeys bound on the Links screen only while one or more links are selected, and their text on the shortcuts sheet. */
export const BULK_KEYS = {
  "shift+d": "Delete the selected links",
  s: "Schedule the selected links",
  m: "Move the selected links",
  r: "Redirect type and options",
  p: "Set or remove a password",
  c: "Copy the short links",
  "shift+e": "Export the selected links as CSV",
} as const;

// In bar order; the first three stay on the phone bar, the rest go under More.
const ACTIONS: [BulkAction, string, keyof typeof BULK_KEYS][] = [
  ["delete", "Delete", "shift+d"],
  ["schedule", "Schedule", "s"],
  ["move", "Move", "m"],
  ["redirect", "Redirect", "r"],
  ["password", "Password", "p"],
  ["copy", "Copy", "c"],
  ["export", "Export", "shift+e"],
];
const ON_PHONE_BAR = 3;

const ActionButton = ({ a, label, k, onAction }: { a: BulkAction; label: string; k: string; onAction: (a: BulkAction) => void }) => (
  <button type="button" className="btn" onClick={() => onAction(a)} aria-keyshortcuts={keyLabels(k).join("+")}>
    {label} <span className="k">{keyLabels(k).join(" ")}</span>
  </button>
);

/** "N selected" and the bulk actions. Desktop: a bar above the table. Phone: fixed to the bottom with More for the rest. */
export function BulkBar({ count, cannot, onAction, onClear }: { count: number; cannot: number; onAction(a: BulkAction): void; onClear(): void }) {
  const phone = useMedia(PHONE);
  const [more, setMore] = useState(false);
  const shown = phone ? ACTIONS.slice(0, ON_PHONE_BAR) : ACTIONS;
  // The More sheet is a sibling of the bar: the phone bar is fixed, a stacking context that would cap the sheet's layer.
  return (
    <>
      <div className="bulkbar" role="region" aria-label="Selected links">
        <span className="bb-n">
          <b>{count} selected</b>
          {cannot > 0 && <small>{cannot} you cannot change</small>}
        </span>
        <div className="bb-acts">
          {shown.map(([a, label, k]) => (
            <ActionButton key={a} a={a} label={label} k={k} onAction={onAction} />
          ))}
          {phone && (
            <button type="button" className="btn" onClick={() => setMore(true)}>
              More
            </button>
          )}
          <button type="button" className="btn ghost" onClick={onClear} aria-keyshortcuts="Escape">
            Clear <span className="k">Esc</span>
          </button>
        </div>
      </div>
        {more && (
          <Sheet label="More actions" onClose={() => setMore(false)}>
            <div className="sh-head">
              <h2>More actions</h2>
            </div>
            <div className="sh-body bb-more">
              {ACTIONS.slice(ON_PHONE_BAR).map(([a, label, k]) => (
                <ActionButton
                  key={a}
                  a={a}
                  label={label}
                  k={k}
                  onAction={(x) => {
                    setMore(false);
                    onAction(x);
                  }}
                />
              ))}
            </div>
          </Sheet>
        )}
    </>
  );
}
