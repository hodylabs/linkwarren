import { useEffect, useRef, useState } from "react";
import { api, ApiError, type AnalyticsReport } from "../api";
import { errorText } from "../copy";
import { useHotkeys, type Bindings } from "../keys";
import { navigate, useRoute } from "../router";
import { switcherDomains } from "../shell/palette";
import { useOpenSheets } from "../shell/Sheet";
import { Kbd, ScreenHeader, Seg } from "../shell/ui";
import { can } from "../perms";
import { useApp } from "../state";
import { Breakdowns } from "./Breakdowns";
import { ClicksChart } from "./ClicksChart";
import { downloadCsv } from "./csv";
import { DomainPicker } from "./DomainPicker";
import { filtersQuery, rangeProblem, readFilters, utcToday, type Filters, type Range } from "./filters";
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
  off: "Live clicks are not set up on this instance (Analytics Engine, see the deploy guide). Showing daily totals only.",
  unavailable: "Clicks from the last day or two could not be loaded. Try again shortly.",
} as const;
/** The 24 hour view reads the live data only, so with live off or unavailable it has no clicks to show. */
const HOURLY_EMPTY = {
  off: "Hourly clicks need live clicks, which are off on this instance. Pick 7 days or longer for daily totals.",
  unavailable: "Hourly clicks could not be loaded. Try again shortly, or pick 7 days or longer for daily totals.",
} as const;
const DEBOUNCE_MS = 250;

export function AnalyticsScreen() {
  const { me, domains: listed, overlay } = useApp();
  // R10: a domain manager also lists domains they cannot use (canUse false); their analytics need analytics.all.
  const domains = can(me, "analytics.all") ? listed : listed.filter((d) => d.canUse !== false);
  const sheets = useOpenSheets();
  const { query } = useRoute();
  const today = utcToday();
  const f = readFilters(query, today);
  const key = filtersQuery(f);
  const problem = f.range === "custom" ? rangeProblem(f.from, f.to, today) : null;
  const invalid = problem !== null;

  const [qInput, setQInput] = useState(f.q);
  const [picker, setPicker] = useState(false);
  const [table, setTable] = useState(false);
  // The report with the filters it answers, so a report never stands in for other filters.
  const [loaded, setLoaded] = useState<{ key: string; report: AnalyticsReport } | null>(null);
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
        if (g === seq.current) setLoaded({ key, report: r });
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

  // R10: analytics.all reaches domains /api/domains does not list; the report names them, so they can be picked too.
  const extra = can(me, "analytics.all")
    ? (loaded?.report.domains ?? []).filter((r) => !domains.some((d) => d.id === r.domainId)).map((r) => ({ id: r.domainId, host: r.host }))
    : [];
  const pickable = [...switcherDomains(domains), ...extra.sort((a, b) => a.host.localeCompare(b.host))];
  const hostOf = (id: string) => pickable.find((d) => d.id === id)?.host ?? id;
  const n = f.domains.length;
  const crumb = n === 0 ? "all domains you can see" : n === 1 ? `on ${hostOf(f.domains[0]!)}` : `${n} domains`;
  const chipLabel = n === 0 ? "All domains" : n === 1 ? hostOf(f.domains[0]!) : `${n} domains`;
  const toggle = (id: string) => go({ domains: f.domains.includes(id) ? f.domains.filter((d) => d !== id) : [...f.domains, id] });
  const clearQ = () => {
    cancelSearch();
    setQInput("");
    go({ q: "" });
  };
  // Dates apply from the native change event, which some browsers fire on every keystroke once the value parses
  // (typing a year gives 0002, 0020, 0202 first). So: a year under 1000 is still being typed and is ignored, a change
  // waits for the debounce, and leaving the field applies it at once. An emptied field is ignored.
  const fromRef = useRef<HTMLInputElement>(null);
  const toRef = useRef<HTMLInputElement>(null);
  const custom = f.range === "custom";
  useEffect(() => {
    if (!custom) return;
    const pairs = [[fromRef.current, "from"], [toRef.current, "to"]] as const;
    const offs = pairs.map(([el, which]) => {
      let t: ReturnType<typeof setTimeout> | undefined;
      const apply = () => {
        clearTimeout(t);
        t = undefined;
        if (el?.value && el.value >= "1000") goRef.current({ [which]: el.value });
      };
      const onChange = () => {
        clearTimeout(t);
        t = setTimeout(apply, DEBOUNCE_MS);
      };
      const onBlur = () => {
        if (t !== undefined) apply();
      };
      el?.addEventListener("change", onChange);
      el?.addEventListener("blur", onBlur);
      return () => {
        clearTimeout(t);
        el?.removeEventListener("change", onChange);
        el?.removeEventListener("blur", onBlur);
      };
    });
    return () => offs.forEach((off) => off());
  }, [custom]);
  // Back/forward changes the URL dates under uncontrolled inputs: copy them in (a no-op while typing, as the value already matches).
  useEffect(() => {
    if (fromRef.current && fromRef.current.value !== f.from) fromRef.current.value = f.from;
    if (toRef.current && toRef.current.value !== f.to) toRef.current.value = f.to;
  }, [f.from, f.to, custom]);
  const anyFilter = n > 0 || f.q !== "" || f.range === "custom";
  // Invalid filters or a failed request show no numbers; a newer request in flight dims the older ones (aria-busy).
  const report = !invalid && !error ? loaded?.report ?? null : null;
  const stale = report !== null && loaded?.key !== key;
  const canExport = report !== null && !stale;

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
        {/* Enabled only while the report on screen answers the current filters: the CSV is built from it (R10). */}
        <button type="button" className="btn act" ref={exportRef} disabled={!canExport} aria-keyshortcuts="X" onClick={() => canExport && downloadCsv(report)}>
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
          <div
            className="ddwrap"
            ref={wrapRef}
            onBlur={(e) => {
              if (picker && !e.currentTarget.contains(e.relatedTarget as Node | null)) setPicker(false);
            }}
          >
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
            {picker && <DomainPicker domains={pickable} selected={f.domains} onToggle={toggle} onAll={() => go({ domains: [] })} onClose={closePicker} />}
          </div>
          <span className="count">Bots and link previews are left out</span>
        </div>
        {invalid && <p className="err" role="alert">{problem === "order" ? "From must be on or before To" : errorText("bad_range")}</p>}
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
          <div className={stale ? "an-data stale" : "an-data"} aria-busy={stale}>
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
            <ClicksChart
              series={report.series}
              unit={report.unit}
              table={table}
              onToggle={() => setTable((t) => !t)}
              empty={report.unit === "hour" && report.live !== "ok" ? HOURLY_EMPTY[report.live] : undefined}
            />
            <Breakdowns report={report} />
          </div>
        )}
      </div>
    </>
  );
}
