import { forwardRef, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, type QrLabel } from "../api";
import { errorText } from "../copy";
import { Icon } from "../shell/ui";
import { useApp } from "../state";
import { download, fileName, qrMatrix, qrPath, qrPng, qrSvg, qrText } from "./qr";

const MARGIN = 4;
/** Labels per link (the server's cap, S13 contract). */
export const MAX_LABELS = 20;
const LABEL_MAX = 100; // the server's rule (checkLinkName)

/** SVG and PNG downloads of one QR content; `suffix` tells labelled prints apart in the file name. */
function useDownloads(host: string, slug: string, code?: string, suffix?: string) {
  const app = useApp();
  const base = suffix ? `${slug}-${suffix}` : slug;
  const matrix = () => qrMatrix(qrText(host, slug, code));
  return {
    svg: () => download(fileName(host, base, "svg"), new Blob([qrSvg(matrix(), MARGIN)], { type: "image/svg+xml" })),
    png: () => qrPng(matrix(), 16, MARGIN).then((b) => download(fileName(host, base, "png"), b), () => app.announce("Could not make the PNG")),
  };
}

/** A short link's QR code and its downloads (the QR code sheet of a link). Download SVG takes focus when the sheet opens. */
export const QrPanel = forwardRef<HTMLButtonElement, { host: string; slug: string; linkId?: string; canEdit?: boolean }>(function QrPanel({ host, slug, linkId, canEdit }, ref) {
  const m = useMemo(() => qrMatrix(qrText(host, slug)), [host, slug]);
  const size = m.length + 2 * MARGIN;
  const label = `QR code for ${host}/${slug}`;
  const dl = useDownloads(host, slug);

  return (
    <div className="qr-edit">
      <div className="qr">
        <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shapeRendering="crispEdges">
          <rect width={size} height={size} fill="#FFFFFF" />
          <path fill="#15181D" d={qrPath(m, MARGIN)} />
        </svg>
        <div>
          <p>Encodes the short link, so you can change the destination after printing. Download SVG or PNG.</p>
          <div className="row">
            <button type="button" className="btn sm" ref={ref} onClick={dl.svg}>
              <Icon name="dl" />
              Download SVG
            </button>
            <button type="button" className="btn sm" onClick={() => void dl.png()}>
              <Icon name="dl" />
              Download PNG
            </button>
          </div>
        </div>
      </div>
      {linkId && canEdit && <QrLabels host={host} slug={slug} linkId={linkId} />}
    </div>
  );
});

/**
 * S13: labelled prints ("Flyer", "Business card"): each is its own QR code (`?lw=qr.<code>`), counted apart in analytics.
 * Old prints keep working as "QR, no label". Shown to people who may edit the link (the API's own rule).
 */
function QrLabels({ host, slug, linkId }: { host: string; slug: string; linkId: string }) {
  const app = useApp();
  const [items, setItems] = useState<QrLabel[] | null>(null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const path = `/api/links/${encodeURIComponent(linkId)}/qr-labels`;
  const fail = (e: unknown) => setError(errorText(e instanceof ApiError ? e.code : "internal"));

  useEffect(() => {
    const ac = new AbortController();
    api<{ items: QrLabel[] }>("GET", path, undefined, ac.signal).then((r) => setItems(r.items), (e: unknown) => {
      if (!ac.signal.aborted) fail(e);
    });
    return () => ac.abort();
  }, [path]);

  const once = async (fn: () => Promise<void>) => {
    if (busy.current) return;
    busy.current = true;
    setError(null);
    try {
      await fn();
    } catch (e) {
      fail(e);
    }
    busy.current = false;
  };
  const add = () => once(async () => {
    const text = draft.trim();
    if (!text) return;
    const l = await api<QrLabel>("POST", path, { label: text });
    setItems((cur) => [...(cur ?? []), l]);
    setDraft("");
    app.announce(`Added ${text}`);
  });
  const rename = () => once(async () => {
    if (!editing) return;
    const text = editing.text.trim();
    if (!text) return;
    const l = await api<QrLabel>("PATCH", `${path}/${encodeURIComponent(editing.id)}`, { label: text });
    setItems((cur) => (cur ?? []).map((x) => (x.id === l.id ? l : x)));
    setEditing(null);
  });
  const remove = (l: QrLabel) => once(async () => {
    await api<void>("DELETE", `${path}/${encodeURIComponent(l.id)}`);
    setItems((cur) => (cur ?? []).filter((x) => x.id !== l.id));
    app.announce(`Deleted ${l.label}`);
  });

  const full = (items?.length ?? 0) >= MAX_LABELS;
  return (
    <section className="qrl" aria-label="Labelled prints">
      <h3>
        Labelled prints{items && items.length > 0 && <span className="muted">{items.length}</span>}
      </h3>
      <p className="hint">One QR code per print (flyer, business card), counted apart in analytics. Codes already printed keep working.</p>
      <form className="qrl-add" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <input className="input sans" value={draft} maxLength={LABEL_MAX} placeholder="Label, for example Flyer" aria-label="New print label" disabled={!items || full} onChange={(e) => setDraft(e.target.value)} />
        <button type="submit" className="btn sm" disabled={!items || full || !draft.trim()}>
          <Icon name="plus" />Add
        </button>
      </form>
      {full && <p className="hint">{MAX_LABELS} labels is the most a link can have.</p>}
      {items && items.length > 0 && (
        <ul>
          {items.map((l) => (
            <LabelRow key={l.id} host={host} slug={slug} l={l}
              editing={editing?.id === l.id ? editing.text : null}
              onEdit={(text) => setEditing(text === null ? null : { id: l.id, text })}
              onRename={() => void rename()} onDelete={() => void remove(l)} />
          ))}
        </ul>
      )}
      {error && <p className="err" role="alert">{error}</p>}
    </section>
  );
}

function LabelRow({ host, slug, l, editing, onEdit, onRename, onDelete }: {
  host: string; slug: string; l: QrLabel; editing: string | null; onEdit(text: string | null): void; onRename(): void; onDelete(): void;
}) {
  const dl = useDownloads(host, slug, l.code, l.label);
  if (editing !== null)
    return (
      <li>
        <form className="qrl-add" onSubmit={(e) => { e.preventDefault(); onRename(); }} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onEdit(null); } }}>
          <input className="input sans" value={editing} maxLength={LABEL_MAX} aria-label={`New name for ${l.label}`} autoFocus onChange={(e) => onEdit(e.target.value)} />
          <button type="submit" className="btn sm" disabled={!editing.trim()}>Save</button>
          <button type="button" className="btn sm" onClick={() => onEdit(null)}>Cancel</button>
        </form>
      </li>
    );
  return (
    <li>
      <span className="name">{l.label}</span>
      <span className="code">{l.code}</span>
      <button type="button" className="btn sm" onClick={dl.svg} aria-label={`Download SVG for ${l.label}`}><Icon name="dl" />SVG</button>
      <button type="button" className="btn sm" onClick={() => void dl.png()} aria-label={`Download PNG for ${l.label}`}><Icon name="dl" />PNG</button>
      <button type="button" className="btn sm icon" onClick={() => onEdit(l.label)} aria-label={`Rename ${l.label}`}><Icon name="edit" /></button>
      <button type="button" className="btn sm icon" onClick={onDelete} aria-label={`Delete ${l.label}`}><Icon name="trash" /></button>
    </li>
  );
}
