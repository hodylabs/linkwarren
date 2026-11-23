import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { checkSlugShape } from "../../../src/validate";
import { api, ApiError, type Link, type Page } from "../api";
import { errorText } from "../copy";
import { navigate } from "../router";
import { can, canSee } from "../perms";
import { useApp } from "../state";
import { Kbd } from "./ui";
import { buildCommands, paletteKey, type Command } from "./palette";
import { Sheet } from "./Sheet";

type Item = { id: string; label: string; sub?: string; keys?: string; mono?: boolean; run: () => void };
type Section = { title: string; items: Item[] };

const includes = (hay: string | null | undefined, needle: string) => (hay ?? "").toLowerCase().includes(needle.toLowerCase());

function Keys({ keys, buf }: { keys: string; buf: string }) {
  return (
    <span className="keys">
      {[...keys].map((ch, i) => (
        <kbd key={i} className={i < buf.length ? "done" : i === buf.length && buf ? "next" : undefined}>
          {ch.toUpperCase()}
        </kbd>
      ))}
    </span>
  );
}

export function Palette() {
  const app = useApp();
  const { me, domains, users, currentDomainId, close } = app;
  const cmds = useMemo(() => buildCommands(app, me, me.authMode === "app"), [app.domains, app.open, app.setCurrentDomain, me]); // eslint-disable-line react-hooks/exhaustive-deps
  const [buf, setBuf] = useState("");
  const [text, setText] = useState("");
  const [sel, setSel] = useState(0);
  const [recent, setRecent] = useState<Link[]>([]);
  const [found, setFound] = useState<{ q: string; items: Link[]; error?: string } | null>(null);

  const linksPath = (q?: string) => {
    const p = new URLSearchParams();
    if (q) p.set("q", q.slice(0, 48));
    if (currentDomainId) p.set("domain", currentDomainId);
    const s = p.toString();
    return `/api/links${s ? `?${s}` : ""}`;
  };

  useEffect(() => {
    const ctrl = new AbortController();
    api<Page<Link>>("GET", linksPath(), undefined, ctrl.signal)
      .then((r) => !ctrl.signal.aborted && setRecent(r.items.slice(0, 3)))
      .catch(() => {}); // Recent links are a convenience; sign-out is already surfaced by the api layer.
    return () => ctrl.abort();
  }, [currentDomainId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!text) return setFound(null);
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      api<Page<Link>>("GET", linksPath(text), undefined, ctrl.signal)
        .then((r) => !ctrl.signal.aborted && setFound({ q: text, items: r.items.slice(0, 5) }))
        .catch((e: unknown) => !ctrl.signal.aborted && setFound({ q: text, items: [], error: e instanceof ApiError ? e.code : "internal" }));
    }, 150);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [text, currentDomainId]); // eslint-disable-line react-hooks/exhaustive-deps

  const hostOf = (id: string) => domains.find((d) => d.id === id)?.host;
  const cmdItem = (c: Command): Item => ({ id: `c-${c.keys}`, label: c.label, keys: c.keys, run: c.run });
  const linkItem = (l: Link): Item => ({
    id: `l-${l.id}`, label: l.slug, sub: hostOf(l.domainId), mono: true,
    run: () => navigate(`/links?q=${encodeURIComponent(l.slug)}&sel=${encodeURIComponent(l.id)}`),
  });
  const cmdSections = (list: Command[]): Section[] =>
    (["Go to", "Create", "Switch", "Help"] as const)
      .map((title) => ({ title, items: list.filter((c) => c.section === title).map(cmdItem) }))
      .filter((s) => s.items.length);

  const sections: Section[] = [];
  if (text) {
    sections.push(...cmdSections(cmds.filter((c) => includes(c.label, text))));
    if (found?.q === text && found.items.length) sections.push({ title: "Links", items: found.items.map(linkItem) });
    const doms = domains.filter((d) => includes(d.host, text));
    if (doms.length)
      sections.push({ title: "Domains", items: doms.map((d) => ({ id: `d-${d.id}`, label: d.host, mono: true, run: () => navigate(`/domains?sel=${encodeURIComponent(d.id)}`) })) });
    const people = canSee(me, "people") ? (users ?? []).filter((u) => includes(u.name, text) || includes(u.email, text)) : [];
    if (people.length)
      sections.push({ title: "People", items: people.map((u) => ({ id: `p-${u.id}`, label: u.name || u.email, sub: u.name ? u.email : undefined, run: () => navigate(`/people?sel=${encodeURIComponent(u.id)}`) })) });
  } else if (buf) {
    sections.push(...cmdSections(cmds.filter((c) => c.keys.startsWith(buf.toLowerCase()))));
  } else {
    sections.push(...cmdSections(cmds.filter((c) => c.section !== "Help" && !c.quiet)));
    if (recent.length) sections.push({ title: "Recent links", items: recent.map(linkItem) });
  }
  const flat = sections.flatMap((s) => s.items);
  const at = Math.min(sel, Math.max(flat.length - 1, 0));
  const settled = text !== "" && found?.q === text;
  const failed = settled && found.error !== undefined;
  const nothing = settled && !failed && flat.length === 0;
  const canCreate = can(me, "links.create") && checkSlugShape(text).ok;

  const choose = (run: () => void) => {
    close();
    run(); // after close, so a run that opens another overlay wins
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const composing = e.nativeEvent.isComposing;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (flat.length) setSel((at + (e.key === "ArrowDown" ? 1 : flat.length - 1)) % flat.length);
      return;
    }
    if (e.key === "Enter") {
      if (composing) return;
      e.preventDefault();
      if (flat[at]) choose(flat[at].run);
      else if (nothing && canCreate) choose(() => app.open({ kind: "newLink", slug: text }));
      return;
    }
    const r = paletteKey({ buf, text }, { key: e.key, ctrl: e.ctrlKey, meta: e.metaKey, alt: e.altKey, composing }, cmds);
    if (!r.consumed) return;
    e.preventDefault();
    setBuf(r.s.buf);
    setText(r.s.text);
    setSel(0);
    if (r.run) choose(r.run.run);
  };

  return (
    <Sheet label="Search and go" onClose={close} cls="palette">
      <div className="p-in">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        {buf && <span className="buf on">{buf.toUpperCase().split("").join(" ")} …</span>}
        <input
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-controls="p-list"
          aria-activedescendant={flat[at] ? `po-${flat[at].id}` : undefined}
          aria-label="Search or shortcut"
          placeholder="Search, or press a letter: g go to, c create"
          autoComplete="off"
          value={text}
          onChange={(e) => {
            setText(buf + e.target.value); // a paste or IME commit after buffered letters keeps them
            setBuf("");
            setSel(0);
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      <div className="p-list" id="p-list" role="listbox">
        {sections.map((s) => (
          <div key={s.title} role="group" aria-label={s.title}>
            <div className="p-sec">{s.title}</div>
            {s.items.map((it) => (
              <div key={it.id} id={`po-${it.id}`} role="option" className="p-item" aria-selected={flat[at]?.id === it.id} onMouseMove={() => setSel(flat.indexOf(it))} onClick={() => choose(it.run)}>
                <span className={it.mono ? "lbl mono" : "lbl"}>{it.label}</span>
                {it.sub && <span className="sub">{it.sub}</span>}
                {it.keys && <Keys keys={it.keys} buf={buf} />}
              </div>
            ))}
          </div>
        ))}
        {failed && (
          <div className="p-sec" role="alert">
            Could not search links: {errorText(found!.error!)}
          </div>
        )}
        {nothing && (
          <div className="p-sec">
            Nothing matches "{text}".{canCreate && " Press Enter to create a link with that slug."}
          </div>
        )}
      </div>
      <div className="p-foot">
        <span><Kbd>↑</Kbd><Kbd>↓</Kbd> move</span>
        <span><Kbd>Enter</Kbd> open</span>
        <span><Kbd>Backspace</Kbd> back a letter</span>
        <span><Kbd>?</Kbd> all shortcuts</span>
        <span className="end"><Kbd>Esc</Kbd> close</span>
      </div>
    </Sheet>
  );
}
