import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, ApiError, type Link, type Page } from "../api";
import { errorText } from "../copy";
import { useHotkeys } from "../keys";
import { can } from "../perms";
import { Confirm, Sheet } from "../shell/Sheet";
import { Empty, PrimaryButton, ScreenHeader, Seg, Tag } from "../shell/ui";
import { useApp } from "../state";
import { download, fileName, qrMatrix, qrPath, qrPng, qrSvg, qrText } from "../links/qr";
import {
  DEFAULT_STYLE, TEXT_MAX, payloadOf, qrProblem, styleProblem,
  type Ecc, type QrData, type QrItem, type QrKind, type QrRead, type QrStyle, type WifiSecurity,
} from "../../../src/qrcode";

const MARGIN = 4;
const DEBOUNCE_MS = 250;
const code = (e: unknown) => (e instanceof ApiError ? e.code : "internal");

export const KIND_LABEL: Record<QrKind, string> = { wifi: "Wi-Fi", url: "Web address", text: "Text", email: "Email", phone: "Phone", sms: "SMS", link: "Short link" };
const KINDS = (Object.keys(KIND_LABEL) as QrKind[]).map((value) => ({ value, label: KIND_LABEL[value] }));
const SECURITY: { value: WifiSecurity; label: string }[] = [{ value: "WPA", label: "WPA or WPA2/3" }, { value: "WEP", label: "WEP" }, { value: "nopass", label: "Open" }];
const ECC: { value: Ecc; label: string }[] = [{ value: "L", label: "Low" }, { value: "M", label: "Medium" }, { value: "Q", label: "High" }, { value: "H", label: "Highest" }];
const BLANK: { [K in QrKind]: QrData[K] } = {
  wifi: { ssid: "", security: "WPA", hidden: false }, url: { url: "" }, text: { text: "" }, email: { to: "", subject: "", body: "" },
  phone: { number: "" }, sms: { number: "", message: "" }, link: { linkId: "" },
};
type Addr = { host: string; slug: string };

/** The text a code carries, its matrix, and the first problem (an error code) when it cannot be drawn yet. */
export function render(kind: QrKind, data: QrData[QrKind], password: string, link: Addr | null | undefined, ecc: Ecc): { m: boolean[][] | null; problem: string | null } {
  const problem = kind === "link" ? (link ? null : "qr_link") : qrProblem(kind, data, password);
  if (problem) return { m: null, problem };
  try {
    return { m: qrMatrix(kind === "link" ? qrText(link!.host, link!.slug) : payloadOf(kind, data as never, password), ecc), problem: null };
  } catch {
    return { m: null, problem: "qr_too_long" };
  }
}

function QrImage({ m, style, label, cls }: { m: boolean[][]; style: QrStyle; label?: string; cls?: string }) {
  const size = m.length + 2 * MARGIN;
  return (
    <svg className={cls} viewBox={`0 0 ${size} ${size}`} shapeRendering="crispEdges" {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}>
      <rect width={size} height={size} fill={style.bg} />
      <path fill={style.fg} d={qrPath(m, MARGIN)} />
    </svg>
  );
}

/** One field: label above, the control in a .ctl box. */
function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="f">
      <label htmlFor={id}>
        {label} {hint && <span>{hint}</span>}
      </label>
      <div className="ctl">{children}</div>
    </div>
  );
}

/** Short links the person can use, found by slug or destination (GET /api/links?q=). */
function LinkPicker({ value, current, onPick }: { value: string; current: Addr | null | undefined; onPick(id: string, a: Addr): void }) {
  const { domains } = useApp();
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Link[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const ctl = new AbortController();
    const t = setTimeout(() => {
      api<Page<Link>>("GET", `/api/links${q ? `?q=${encodeURIComponent(q)}` : ""}`, undefined, ctl.signal).then(
        (p) => { setFound(p.items); setError(null); },
        (e: unknown) => void (!ctl.signal.aborted && setError(errorText(code(e)))),
      );
    }, DEBOUNCE_MS);
    return () => { clearTimeout(t); ctl.abort(); };
  }, [q]);
  const host = (l: Link) => domains.find((d) => d.id === l.domainId)?.host ?? "";
  const options = found.filter((l) => host(l));
  return (
    <>
      <Field id="qr-link-q" label="Find a short link" hint="by slug or destination">
        <input id="qr-link-q" value={q} maxLength={40} autoComplete="off" spellCheck={false} onChange={(e) => setQ(e.target.value)} />
      </Field>
      <Field id="qr-link" label="Short link">
        {/* The first option names the current pick, so the select always shows it. */}
        <select id="qr-link" value="" onChange={(e) => {
          const l = options.find((x) => x.id === e.target.value);
          if (l) onPick(l.id, { host: host(l), slug: l.slug });
        }}>
          <option value="">{current ? `${current.host}/${current.slug}` : value ? "Link deleted, pick another" : "Pick a link"}</option>
          {options.filter((l) => l.id !== value).map((l) => (
            <option key={l.id} value={l.id}>{host(l)}/{l.slug}</option>
          ))}
        </select>
      </Field>
      {error && <p className="err" role="alert">{error}</p>}
      <p className="utm-note">Scans count as QR scans of this link, and the code follows the link if its address changes.</p>
    </>
  );
}

/** Create (id null) or edit a code. Its own sheet; the delete confirm opens over it. */
function QrSheet({ id, onClose, onSaved, onDeleted }: { id: string | null; onClose(): void; onSaved(q: QrItem): void; onDeleted(id: string): void }) {
  const app = useApp();
  const [loaded, setLoaded] = useState(id === null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<QrKind>("wifi");
  const [drafts, setDrafts] = useState(BLANK);
  const [password, setPassword] = useState(""); // never logged or announced
  const [pwTouched, setPwTouched] = useState(false);
  const [unreadable, setUnreadable] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const [style, setStyle] = useState<QrStyle>(DEFAULT_STYLE);
  const [link, setLink] = useState<Addr | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const busy = useRef(false);

  useEffect(() => {
    if (id === null) return;
    const ctl = new AbortController();
    api<QrRead>("GET", `/api/qr-codes/${encodeURIComponent(id)}`, undefined, ctl.signal).then(
      (q) => {
        setName(q.name);
        setKind(q.kind);
        setDrafts((d) => ({ ...d, [q.kind]: { ...BLANK[q.kind], ...q.data } }));
        setPassword(q.password ?? "");
        setUnreadable(q.hasPassword && q.password === null);
        setStyle(q.style);
        setLink(q.link);
        setLoaded(true);
      },
      (e: unknown) => void (!ctl.signal.aborted && setError(errorText(code(e)))),
    );
    return () => ctl.abort();
  }, [id]);

  const data = drafts[kind];
  const set = <K extends QrKind>(k: K, patch: Partial<QrData[K]>) => setDrafts((d) => ({ ...d, [k]: { ...d[k], ...patch } }));
  const wifi = drafts.wifi;
  const takesPw = kind === "wifi" && wifi.security !== "nopass";
  const sp = styleProblem(style);
  const shown = sp ? DEFAULT_STYLE : style;
  // An unreadable saved password would draw a code that cannot join the network: no preview or download until it is typed again.
  const { m, problem } = useMemo(
    () => (takesPw && unreadable ? { m: null, problem: "wifi_password_unreadable" } : render(kind, data, takesPw ? password : "", link, style.ecc)),
    [kind, data, takesPw, unreadable, password, link, style.ecc],
  );

  const save = async () => {
    if (busy.current || !loaded) return;
    const stop = problem ?? sp;
    if (stop) return setError(errorText(stop));
    busy.current = true;
    setError(null);
    try {
      const body: Record<string, unknown> = { name, kind, data, style };
      // Omitted keeps the stored password; sent only when typed (or cleared) here.
      if (takesPw && (id === null || pwTouched)) body.password = password;
      const q = id === null ? await api<QrItem>("POST", "/api/qr-codes", body) : await api<QrItem>("PATCH", `/api/qr-codes/${encodeURIComponent(id)}`, body);
      app.announce(id === null ? `Created ${q.name}` : `Saved ${q.name}`);
      onSaved(q);
    } catch (e) {
      setError(errorText(code(e)));
    } finally {
      busy.current = false;
    }
  };
  const remove = async () => {
    if (busy.current || id === null) return;
    busy.current = true;
    try {
      await api("DELETE", `/api/qr-codes/${encodeURIComponent(id)}`);
      app.announce(`Deleted ${name}`);
      onDeleted(id);
    } catch (e) {
      setConfirm(false);
      setError(errorText(code(e)));
    } finally {
      busy.current = false;
    }
  };
  useHotkeys({ "mod+enter": () => void save() }, !confirm);

  const file = (ext: "svg" | "png") => fileName("qr", name || "code", ext);
  const svg = () => m && download(file("svg"), new Blob([qrSvg(m, MARGIN, shown.fg, shown.bg)], { type: "image/svg+xml" }));
  const png = () => m && qrPng(m, 16, MARGIN, shown.fg, shown.bg).then((b) => download(file("png"), b), () => app.announce("Could not make the PNG"));
  const title = id === null ? "New QR code" : "Edit QR code";

  return (
    <>
      <Sheet label={title} onClose={onClose}>
        <div className="sh-head">
          <h2>{title}</h2>
          <span className="x"><kbd>Esc</kbd> close</span>
        </div>
        <div className="sh-body qr-edit">
          {!loaded && !error && <p className="muted">Loading the QR code</p>}
          {loaded && (
            <>
              <Field id="qr-name" label="Name" hint="shown in this list, not in the code">
                <input id="qr-name" autoFocus value={name} maxLength={80} autoComplete="off" onChange={(e) => setName(e.target.value)} />
              </Field>
              <div className="f">
                <p className="lbl">Kind</p>
                <Seg options={KINDS} value={kind} onChange={setKind} label="Kind" wrap />
              </div>
              {kind === "wifi" && (
                <>
                  <Field id="qr-ssid" label="Network name">
                    <input id="qr-ssid" value={wifi.ssid} autoComplete="off" spellCheck={false} onChange={(e) => set("wifi", { ssid: e.target.value })} />
                  </Field>
                  <div className="f">
                    <p className="lbl">Security</p>
                    <Seg options={SECURITY} value={wifi.security} onChange={(security) => set("wifi", { security })} label="Security" wrap />
                  </div>
                  {takesPw && (
                    <div className="f pw">
                      <label htmlFor="qr-pw">Password</label>
                      <div className="ctl">
                        <input id="qr-pw" type={showPw ? "text" : "password"} value={password} maxLength={64} autoComplete="new-password" spellCheck={false} autoCapitalize="off"
                          aria-describedby="qr-pw-hint" onChange={(e) => { setPassword(e.target.value); setPwTouched(true); setUnreadable(false); }} />
                        <button type="button" className="btn ghost" aria-label={showPw ? "Hide password" : "Show password"} onClick={() => setShowPw((v) => !v)}>
                          {showPw ? "Hide" : "Show"}
                        </button>
                      </div>
                      <p id="qr-pw-hint" className="utm-note">
                        {unreadable ? "The saved password cannot be read on this server any more. Enter it again." : "Stored encrypted. Only people who can edit this code see it."}
                      </p>
                    </div>
                  )}
                  <label className="check">
                    <input type="checkbox" checked={wifi.hidden} onChange={(e) => set("wifi", { hidden: e.target.checked })} />
                    Hidden network
                  </label>
                </>
              )}
              {kind === "url" && (
                <>
                  <Field id="qr-url" label="Web address">
                    <input id="qr-url" type="url" value={drafts.url.url} autoComplete="off" spellCheck={false} placeholder="https://example.com/" onChange={(e) => set("url", { url: e.target.value })} />
                  </Field>
                  <p className="utm-note">A static address: scans are not counted and it cannot change after printing. Use a short link for that.</p>
                </>
              )}
              {kind === "text" && (
                <Field id="qr-text" label="Text" hint={`${[...drafts.text.text].length} of ${TEXT_MAX} characters`}>
                  <textarea id="qr-text" rows={4} value={drafts.text.text} onChange={(e) => set("text", { text: e.target.value })} />
                </Field>
              )}
              {kind === "email" && (
                <>
                  <Field id="qr-to" label="Send to">
                    <input id="qr-to" type="email" value={drafts.email.to} autoComplete="off" spellCheck={false} onChange={(e) => set("email", { to: e.target.value })} />
                  </Field>
                  <Field id="qr-subject" label="Subject" hint="optional">
                    <input id="qr-subject" value={drafts.email.subject} maxLength={150} onChange={(e) => set("email", { subject: e.target.value })} />
                  </Field>
                  <Field id="qr-body" label="Message" hint="optional">
                    <textarea id="qr-body" rows={3} value={drafts.email.body} maxLength={500} onChange={(e) => set("email", { body: e.target.value })} />
                  </Field>
                </>
              )}
              {kind === "phone" && (
                <Field id="qr-phone" label="Phone number">
                  <input id="qr-phone" type="tel" value={drafts.phone.number} autoComplete="off" onChange={(e) => set("phone", { number: e.target.value })} />
                </Field>
              )}
              {kind === "sms" && (
                <>
                  <Field id="qr-sms" label="Phone number">
                    <input id="qr-sms" type="tel" value={drafts.sms.number} autoComplete="off" onChange={(e) => set("sms", { number: e.target.value })} />
                  </Field>
                  <Field id="qr-msg" label="Message" hint="optional">
                    <textarea id="qr-msg" rows={3} value={drafts.sms.message} maxLength={300} onChange={(e) => set("sms", { message: e.target.value })} />
                  </Field>
                </>
              )}
              {kind === "link" && (
                <LinkPicker value={drafts.link.linkId} current={link} onPick={(linkId, a) => { set("link", { linkId }); setLink(a); }} />
              )}
              <div className="qr-style">
                <div className="f">
                  <label htmlFor="qr-fg">Code color</label>
                  <input id="qr-fg" type="color" value={style.fg.toLowerCase()} onChange={(e) => setStyle((s) => ({ ...s, fg: e.target.value }))} />
                </div>
                <div className="f">
                  <label htmlFor="qr-bg">Background</label>
                  <input id="qr-bg" type="color" value={style.bg.toLowerCase()} onChange={(e) => setStyle((s) => ({ ...s, bg: e.target.value }))} />
                </div>
                <div className="f">
                  <p className="lbl">Error correction</p>
                  <Seg options={ECC} value={style.ecc} onChange={(ecc) => setStyle((s) => ({ ...s, ecc }))} label="Error correction" wrap />
                </div>
              </div>
              {sp && <p className="err">{errorText(sp)}</p>}
              <div className="qr" aria-live="polite">
                {m ? <QrImage m={m} style={shown} label={`Preview of ${name || "the QR code"}`} /> : <p className="muted">{problem && errorText(problem)}</p>}
              </div>
            </>
          )}
          {error && <p className="err" role="alert">{error}</p>}
          <div className="actions qr-acts">
            {id !== null && loaded && <button type="button" className="btn ghost danger" onClick={() => setConfirm(true)}>Delete</button>}
            <span className="grow" />
            <button type="button" className="btn" disabled={!m || !!sp} onClick={svg}>Download SVG</button>
            <button type="button" className="btn" disabled={!m || !!sp} onClick={() => void png()}>Download PNG</button>
            <button type="button" className="btn primary" disabled={!loaded} onClick={() => void save()} aria-keyshortcuts="Control+Enter">
              {id === null ? "Create" : "Save"} <span className="k">Ctrl Enter</span>
            </button>
          </div>
        </div>
      </Sheet>
      {confirm && (
        <Confirm title={`Delete ${name}`} text={`Delete ${name}? Printed copies keep working; only the saved code goes.`} ok="Delete"
          onOk={() => void remove()} onCancel={() => setConfirm(false)} />
      )}
    </>
  );
}

export function QrCodesScreen() {
  const { me } = useApp();
  const [items, setItems] = useState<QrItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // id null: a new code. `n` tells sheet openings apart, so a slow save from a closed sheet never closes a newer one.
  const [editing, setEditing] = useState<{ id: string | null; n: number } | undefined>(undefined);
  const opened = useRef(0);
  const edit = (id: string | null) => setEditing({ id, n: ++opened.current });
  const closeIf = (n: number) => setEditing((e) => (e?.n === n ? undefined : e));
  const creator = can(me, "links.create");

  const load = useCallback(() => {
    setError(null);
    api<{ items: QrItem[] }>("GET", "/api/qr-codes").then((r) => setItems(r.items), (e: unknown) => setError(errorText(code(e))));
  }, []);
  useEffect(load, [load]);

  const saved = (q: QrItem, n: number) => {
    setItems((l) => (l ? [q, ...l.filter((x) => x.id !== q.id)] : [q]));
    closeIf(n);
  };
  const deleted = (id: string, n: number) => {
    setItems((l) => l && l.filter((x) => x.id !== id));
    closeIf(n);
  };

  return (
    <>
      {/* New QR code only once the list is in, so a late first load never drops a code just made. */}
      <ScreenHeader
        title="QR codes"
        count={items ? String(items.length) : undefined}
        action={creator && items !== null && <PrimaryButton label="New QR code" onClick={() => edit(null)} />}
      />
      <div className="body solo">
        <section className="list" aria-label="QR codes">
          {error && <p className="err pad" role="alert">{error}</p>}
          {items === null && !error && <p className="muted pad">Loading QR codes</p>}
          {items?.length === 0 && <Empty title="No QR codes yet" text={creator ? "Press New QR code to make one for Wi-Fi, a web address, a message or a short link." : "Nobody has made a QR code yet."} />}
          {items && items.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Kind</th>
                  <th>Preview</th>
                </tr>
              </thead>
              <tbody>
                {items.map((q) => {
                  // The list never carries the Wi-Fi password, so its thumbnail leaves it out; open the code to download it.
                  const { m } = render(q.kind, q.data, "", q.link, q.style.ecc);
                  return (
                    <tr key={q.id}>
                      <td>
                        <button type="button" className="btn ghost qr-open" onClick={() => edit(q.id)}>{q.name}</button>
                      </td>
                      <td>
                        {KIND_LABEL[q.kind]}
                        {q.kind === "link" && (q.link ? <span className="muted mono"> {q.link.host}/{q.link.slug}</span> : <> <Tag tone="bad">Link deleted</Tag></>)}
                      </td>
                      <td>{m && <QrImage m={m} style={q.style} cls="qr-thumb" />}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
      </div>
      {editing && (
        <QrSheet key={editing.n} id={editing.id} onClose={() => closeIf(editing.n)} onSaved={(q) => saved(q, editing.n)} onDeleted={(id) => deleted(id, editing.n)} />
      )}
    </>
  );
}
