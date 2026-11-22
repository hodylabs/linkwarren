import { useEffect, useRef, useState } from "react";
import { api, ApiError, type AnalyticsReport } from "../api";
import { errorText } from "../copy";
import { useHotkeys, type Bindings } from "../keys";
import { navigate, useRoute } from "../router";
import { switcherDomains } from "../shell/palette";
import { useOpenSheets } from "../shell/Sheet";
import { Kbd, ScreenHeader, Seg } from "../shell/ui";
import { useApp } from "../state";
import { Breakdowns } from "./Breakdowns";
import { ClicksChart } from "./ClicksChart";
import { downloadCsv } from "./csv";
import { DomainPicker } from "./DomainPicker";
import { filtersQuery, readFilters, utcToday, type Filters, type Range } from "./filters";
import { tiles } from "./view";

/** Analytics screen hotkeys (outside text fields) and their text on the shortcuts sheet. */
export const ANALYTICS_KEYS = {
  d: "Filter by domain",
  l: "Search links",
  v: "Switch between chart and table",
  r: "Go to the date range",
  x: "Export CSV",
  escape: "Leave the link search",
} as const;

const RANGE_OPTIONS: { value: Range; label: string }[] = [
  { value: "1", label: "24 hours" },
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "custom", label: "Custom" },
];
const LIVE_NOTE = {
  off: "Live clicks need the analytics read token. Showing daily totals only.",
  unavailable: "Clicks from the last day or two could not be loaded. Try again shortly.",
} as const;
const DEBOUNCE_MS = 250;

export function AnalyticsScreen() {
  const { domains, overlay } = useApp();
  const sheets = useOpenSheets();
  const { query } = useRoute();
  const today = utcToday();
  const f = readFilters(query, today);
  const key = filtersQuery(f);
  const invalid = f.range === "custom" && f.from > f.to;

  const [qInput, setQInput] = useState(f.q);
  const [picker, setPicker] = useState(false);
  const [table, setTable] = useState(false);
  const [report, setReport] = useState<AnalyticsReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const exportRef = useRef<HTMLButtonElement>(null);

  const go = (next: Partial<Filters>) => {
    const s = filtersQuery({ ...f, ...next });
    navigate(`/analytics${s ? `?${s}` : ""}`, { replace: true });
  };
  // Timers and native listeners call the latest `go`, so they never write back filters from an older render.
  const goRef = useRef(go);
  goRef.current = go;
  const cancelSearch = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  // Back, forward and the pills change the URL search: show it, unless a typed search is still waiting to be sent.
  useEffect(() => {
    if (!timer.current) setQInput(f.q);
  }, [f.q]);
  useEffect(() => cancelSearch, []);

  // `?pick=1` (palette "af") opens the picker once, then leaves the URL.
  const pick = query.has("pick");
  useEffect(() => {
    if (!pick) return;
    setPicker(true);
    go({});
  }, [pick]);

  // Every filter change is a new request; an answer from an older request never lands (sequence + abort).
  useEffect(() => {
    const g = ++seq.current;
    if (invalid) return;
    const ac = new AbortController();
    setError(null);
    api<AnalyticsReport>("GET", `/api/analytics${key ? `?${key}` : ""}`, undefined, ac.signal).then(
      (r) => {
        if (g === seq.current) setReport(r);
      },
      (e: unknown) => {
        if (g === seq.current && !ac.signal.aborted) setError(errorText(e instanceof ApiError ? e.code : "internal"));
      },
    );
    return () => ac.abort();
  }, [key, invalid]);

  // A mousedown outside the chip and its dropdown closes the dropdown.
  useEffect(() => {
    if (!picker) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setPicker(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [picker]);

  const closePicker = () => {
    setPicker(false);
    chipRef.current?.focus();
  };

  useHotkeys(
    {
      d: () => setPicker(true),
      l: () => searchRef.current?.focus(),
      v: () => setTable((t) => !t),
      r: () => document.querySelector<HTMLElement>('.an [role=radiogroup] [aria-checked="true"]')?.focus(),
      x: () => exportRef.current?.click(),
      escape: (e) => {
        if (e.target === searchRef.current) searchRef.current?.blur();
      },
    } satisfies Bindings<typeof ANALYTICS_KEYS>,
    overlay === null && sheets === 0 && !picker,
  );

  const hostOf = (id: string) => domains.find((d) => d.id === id)?.host ?? id;
  const n = f.domains.length;
  const crumb = n === 0 ? "all domains you can see" : n === 1 ? `on ${hostOf(f.domains[0]!)}` : `${n} domains`;
  const chipLabel = n === 0 ? "All domains" : n === 1 ? hostOf(f.domains[0]!) : `${n} domains`;
  const toggle = (id: string) => go({ domains: f.domains.includes(id) ? f.domains.filter((d) => d !== id) : [...f.domains, id] });
  const clearQ = () => {
    cancelSearch();
    setQInput("");
    go({ q: "" });
  };
  // Dates apply on the native change event (a finished date), not on every edit; an emptied field is ignored.
  const fromRef = useRef<HTMLInputElement>(null);
  const toRef = useRef<HTMLInputElement>(null);
  const custom = f.range === "custom";
  useEffect(() => {
    if (!custom) return;
    const pairs = [[fromRef.current, "from"], [toRef.current, "to"]] as const;
    const offs = pairs.map(([el, which]) => {
      const on = () => {
        if (el?.value) goRef.current({ [which]: el.value });
      };
      el?.addEventListener("change", on);
      return () => el?.removeEventListener("change", on);
    });
    return () => offs.forEach((off) => off());
  }, [custom]);
  const anyFilter = n > 0 || f.q !== "" || f.range === "custom";

  return (
    <>
      <ScreenHeader title="Analytics" text={crumb}>
        <label className="search">
          <input
            ref={searchRef}
            aria-label="Search links"
            placeholder="Search links, for example spring"
            maxLength={48}
            autoComplete="off"
            value={qInput}
            onChange={(e) => {
              const v = e.target.value;
              setQInput(v);
              cancelSearch();
              timer.current = setTimeout(() => {
                timer.current = null;
                goRef.current({ q: v });
              }, DEBOUNCE_MS);
            }}
          />
          <Kbd>L</Kbd>
        </label>
        {/* Disabled until a report has loaded: the CSV is built from the loaded report (R10). */}
        <button type="button" className="btn act" ref={exportRef} disabled={!report} aria-keyshortcuts="X" onClick={() => report && downloadCsv(report)}>
          Export CSV<span className="k2">X</span>
        </button>
      </ScreenHeader>
      <div className="an">
        <div className="fbar" role="toolbar" aria-label="Filters">
          <Seg cls="seg2" label="Date range" options={RANGE_OPTIONS} value={f.range} onChange={(v) => go({ range: v })} />
          {f.range === "custom" && (
            <div className="custom">
              <label>
                From <input type="date" ref={fromRef} max={today} defaultValue={f.from} />
              </label>
              <label>
                To <input type="date" ref={toRef} max={today} defaultValue={f.to} />
              </label>
            </div>
          )}
          <div className="ddwrap" ref={wrapRef}>
            <button
              type="button"
              ref={chipRef}
              className={n ? "chip dd set" : "chip dd"}
              aria-haspopup="listbox"
              aria-expanded={picker}
              aria-keyshortcuts="D"
              onClick={() => (picker ? closePicker() : setPicker(true))}
            >
              {chipLabel} <span className="car" aria-hidden="true">▾</span>
              <Kbd>D</Kbd>
            </button>
            {picker && <DomainPicker domains={switcherDomains(domains)} selected={f.domains} onToggle={toggle} onAll={() => go({ domains: [] })} onClose={closePicker} />}
          </div>
          <span className="count">Bots and link previews are left out</span>
        </div>
        {invalid && <p className="err" role="alert">From must be on or before To</p>}
        {error && !invalid && <p className="err" role="alert">{error}</p>}
        <div className="active">
          {anyFilter && (
            <>
              {n > 0 && (
                <span className="fpill">
                  Domain <b>{f.domains.map(hostOf).join(", ")}</b>
                  <button type="button" aria-label="Clear domain filter" onClick={() => go({ domains: [] })}>×</button>
                </span>
              )}
              {f.q && (
                <span className="fpill">
                  Link contains <b>{f.q}</b>
                  <button type="button" aria-label="Clear link search" onClick={clearQ}>×</button>
                </span>
              )}
              {f.range === "custom" && (
                <span className="fpill">
                  Dates <b>{f.from} to {f.to}</b>
                  <button type="button" aria-label="Clear dates" onClick={() => go({ range: "30" })}>×</button>
                </span>
              )}
              <button
                type="button"
                className="btn ghost"
                onClick={() => {
                  cancelSearch();
                  setQInput("");
                  navigate("/analytics", { replace: true });
                }}
              >
                Clear all
              </button>
            </>
          )}
        </div>
        {report && (
          <>
            {report.live !== "ok" && <p className="note" role="status">{LIVE_NOTE[report.live]}</p>}
            {report.truncated && <p className="note" role="status">Showing the first 500 matching links</p>}
            <div className="tiles">
              {tiles(report).map((t) => (
                <div className="tile2" key={t.label}>
                  <small>{t.label}</small>
                  <b>{t.value}</b>
                  <span className={t.up ? "delta up" : "delta"}>{t.note}</span>
                </div>
              ))}
            </div>
            <ClicksChart series={report.series} unit={report.unit} table={table} onToggle={() => setTable((t) => !t)} />
            <Breakdowns report={report} />
          </>
        )}
      </div>
    </>
  );
}
