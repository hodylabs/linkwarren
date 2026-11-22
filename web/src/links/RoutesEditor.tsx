import { useEffect, useRef, useState } from "react";
import type { Route, RouteDevice } from "../api";
import { Switch } from "../shell/ui";

export const MAX_ROUTES = 10;
const DEVICES: RouteDevice[] = ["mobile", "tablet", "desktop"];
const tokens = (s: string) => s.split(/[\s,]+/).filter(Boolean);
const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Country and device routing rules. Countries are emitted as typed tokens (not yet upper-cased or checked):
 * the caller runs parseCountries before sending, so a bad code can be shown under its row.
 */
export function RoutesEditor({ value, onChange, errors }: { value: Route[]; onChange(r: Route[]): void; errors?: Record<number, string> }) {
  // The raw text per row, so "ca, " keeps its comma while typing; shown only while it still matches the row's countries.
  const [texts, setTexts] = useState<string[]>([]);
  const box = useRef<HTMLDivElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const count = useRef(value.length);
  useEffect(() => {
    // A new row takes focus; after a remove, focus lands on Add rule instead of the page body.
    if (value.length > count.current) box.current?.querySelectorAll<HTMLInputElement>("input[data-countries]")[value.length - 1]?.focus();
    else if (value.length < count.current) addRef.current?.focus();
    count.current = value.length;
  }, [value.length]);

  const set = (i: number, patch: Partial<Route>) => onChange(value.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const remove = (i: number) => {
    onChange(value.filter((_, j) => j !== i));
    setTexts((t) => t.filter((_, j) => j !== i));
  };

  return (
    <div className="routes" ref={box}>
      {value.map((r, i) => {
        const n = i + 1;
        const text = texts[i] !== undefined && same(tokens(texts[i]!), r.countries) ? texts[i]! : r.countries.join(", ");
        const err = errors?.[i];
        return (
          <div key={i} className="rt" role="group" aria-label={`Rule ${n}`}>
            <div className="rt-row">
              <div className="rt-c">
                <span className="rt-l" aria-hidden="true">Countries</span>
                <div className={err ? "ctl bad" : "ctl"}>
                  <input
                    data-countries=""
                    aria-label={`Rule ${n} countries`}
                    placeholder="CA, US"
                    value={text}
                    spellCheck={false}
                    autoComplete="off"
                    aria-invalid={err ? true : undefined}
                    onChange={(e) => {
                      const v = e.target.value;
                      setTexts((t) => Object.assign([...t], { [i]: v }));
                      set(i, { countries: tokens(v) });
                    }}
                  />
                </div>
              </div>
              <div className="rt-d" role="group" aria-label={`Rule ${n} devices`}>
                {DEVICES.map((d) => (
                  <span key={d} className="rt-sw">
                    <Switch
                      label={`Rule ${n} ${d}`}
                      checked={r.devices.includes(d)}
                      onChange={(on) => set(i, { devices: on ? DEVICES.filter((x) => x === d || r.devices.includes(x)) : r.devices.filter((x) => x !== d) })}
                    />
                    <span aria-hidden="true">{d[0]!.toUpperCase() + d.slice(1)}</span>
                  </span>
                ))}
              </div>
            </div>
            <div className="rt-row">
              <div className="rt-u">
                <span className="rt-l" aria-hidden="true">Goes to</span>
                <div className={err ? "ctl bad" : "ctl"}>
                  <input
                    aria-label={`Rule ${n} goes to`}
                    value={r.url}
                    spellCheck={false}
                    autoComplete="off"
                    inputMode="url"
                    onChange={(e) => set(i, { url: e.target.value })}
                  />
                </div>
              </div>
              <button type="button" className="btn" aria-label={`Remove rule ${n}`} onClick={() => remove(i)}>
                Remove
              </button>
            </div>
            {err && (
              <p className="err" role="alert">
                {err}
              </p>
            )}
          </div>
        );
      })}
      {value.length < MAX_ROUTES && (
        <button type="button" className="btn" ref={addRef} onClick={() => onChange([...value, { countries: [], devices: [], url: "" }])}>
          Add rule
        </button>
      )}
      <p className="utm-note">Rules apply top to bottom. Everyone else goes to the main destination.</p>
    </div>
  );
}
