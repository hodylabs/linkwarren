import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { api, ApiError, type CfView, type Domain } from "../api";
import { errorText, plural } from "../copy";
import { rebase } from "../draft";
import { useHotkeys, type Bindings } from "../keys";
import { NavLink } from "../router";
import { getCloudflare } from "../settings/api";
import { Sheet } from "../shell/Sheet";
import { CloseButton, Switch, Tag } from "../shell/ui";
import { useApp } from "../state";
import { DEFAULT_RESERVED } from "../../../src/validate";
import { shortDate } from "../time";
import { CfControls } from "./CfControls";
import { CfStatus } from "./CfStatus";
import { MembersEditor } from "./MembersEditor";
import { canManage, domainDiff, draftOf, ownerLabel, statusTag, type Draft } from "./domainView";
import { cfSettled, useCfPoll } from "./useCfPoll";

type Confirm = "case" | "disable" | "reject" | "takeover";

/** Domain detail hotkeys (owner) and their text on the shortcuts sheet. */
export const DOMAIN_DETAIL_KEYS = {
  a: "Approve or enable the selected domain (owner)",
  f: "Finish connecting the selected domain to Cloudflare (owner)",
  "shift+r": "Reject the selected pending domain (owner)",
  "shift+d": "Disable the selected domain (owner)",
} as const;
const code = (e: unknown) => (e instanceof ApiError ? e.code : "internal");
const loopText = (n: number, host: string) => `${plural(n, "existing link")} ${n === 1 ? "points" : "point"} at ${host} and now loop${n === 1 ? "s" : ""}.`;
const editThem = (n: number) => (n === 1 ? "Edit it" : "Edit them");

export function DomainDetail({ domain, onModal, onClose }: { domain: Domain; onModal(open: boolean): void; onClose(): void }) {
  const app = useApp();
  const { me, users, domains, overlay } = app;
  const isOwner = me.role === "owner";
  const canEdit = canManage(me, domain);
  const [draft, setDraft] = useState(() => draftOf(domain));
  const [errors, setErrors] = useState<ReturnType<typeof domainDiff>["errors"]>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [caseError, setCaseError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [loops, setLoops] = useState(0);
  const busy = useRef(false); // one write at a time: a double Enter or click sends once
  // Latest Cloudflare view from any source: the list, a poll, or an approve answer.
  const [view, setView] = useState<CfView | null>(domain.cloudflare ?? null);
  useEffect(() => void (domain.cloudflare && setView(domain.cloudflare)), [domain.cloudflare]);
  const showCf = canEdit && view !== null && view.kind !== "manual";
  const poll = useCfPoll(showCf ? domain.id : null, view !== null && !cfSettled(view));
  useEffect(() => void (poll.view && setView(poll.view)), [poll.view]);
  // Controls need the owner's "controls on" switch; members never ask (the endpoint is owner only). Errors mean off.
  const [controlsEnabled, setControlsEnabled] = useState(false);
  const accountKind = view?.kind === "account";
  useEffect(() => {
    setControlsEnabled(false);
    if (!isOwner || !accountKind) return;
    const ac = new AbortController();
    getCloudflare(ac.signal).then((s) => setControlsEnabled(s.controlsEnabled), () => {});
    return () => ac.abort();
  }, [isOwner, accountKind, domain.id]);
  const tag = statusTag(view ? { ...domain, cloudflare: view } : domain, isOwner);
  const set = (p: Partial<Draft>) => setDraft((d) => ({ ...d, ...p }));

  useEffect(() => onModal(confirm !== null), [confirm]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onModal(false), []); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = () => app.reloadDomains().catch(() => app.announce("Saved, but the list could not be refreshed"));

  const run = async (fn: () => Promise<void>) => {
    if (busy.current) return;
    busy.current = true;
    try {
      await fn();
    } finally {
      busy.current = false;
    }
  };

  const save = () =>
    run(async () => {
      if (!canEdit) return;
      const { body, errors: bad } = domainDiff(domain, draft, domains.map((d) => d.host));
      setErrors(bad);
      setFormError(null);
      if (Object.keys(bad).length > 0 || Object.keys(body).length === 0) return;
      try {
        const saved = draftOf(await api<Domain>("PATCH", `/api/domains/${encodeURIComponent(domain.id)}`, body)); // the server may normalize a URL
        setDraft((now) => rebase(saved, draft, now)); // edits typed while the save was pending stay
        app.announce("Saved");
        await refresh();
      } catch (e) {
        setFormError(errorText(code(e))); // typed values stay in the form
        if (code(e) === "conflict") void refresh(); // the copy says reload: do it, the typed values still stay
      }
    });

  const toggleCase = () =>
    run(async () => {
      try {
        await api("PATCH", `/api/domains/${encodeURIComponent(domain.id)}`, { caseSensitive: !domain.caseSensitive });
        setConfirm(null);
        app.announce(domain.caseSensitive ? "Case-sensitive slugs off" : "Case-sensitive slugs on");
        await refresh();
      } catch (e) {
        setConfirm(null);
        setCaseError(errorText(code(e))); // the switch shows the saved state, which did not change
      }
    });

  const canApprove = isOwner && domain.status !== "active";
  // An active same-account domain that Cloudflare does not serve yet: approve finishes the attach.
  const canFinish = isOwner && domain.status === "active" && view?.kind === "account" && (view.ownership !== "verified" || view.lastError !== null);
  const canReject = isOwner && domain.status === "pending";
  const path = `/api/domains/${encodeURIComponent(domain.id)}`;

  const disable = () =>
    run(async () => {
      setActionError(null);
      try {
        await api("POST", `${path}/disable`);
        setConfirm(null);
        app.announce("Domain disabled");
        await refresh();
      } catch (e) {
        setConfirm(null);
        setActionError(errorText(code(e)));
      }
    });

  /** Approve, enable, or finish connecting: the same call. A 409 dns_record_exists asks first, then resends with confirmTakeover. */
  const approve = (confirmTakeover = false) =>
    run(async () => {
      setActionError(null);
      const was = domain.status;
      try {
        const res = await api<Domain & { loopLinks?: number }>("POST", `${path}/approve`, confirmTakeover ? { confirmTakeover: true } : {});
        setConfirm(null);
        if (res.cloudflare) setView(res.cloudflare);
        const n = res.loopLinks ?? 0;
        setLoops(n);
        app.announce(n > 0 ? `${loopText(n, domain.host)} ${editThem(n)}.` : was === "active" ? "Domain connected" : was === "disabled" ? "Domain enabled" : "Domain approved");
        await refresh();
      } catch (e) {
        setConfirm(null);
        const c = code(e);
        if (c === "dns_record_exists") return setConfirm("takeover");
        if (c === "not_verified") {
          const v = e instanceof ApiError ? (e.data as { cloudflare?: CfView } | undefined)?.cloudflare : undefined;
          if (v) setView(v);
          return setActionError("Checks have not passed yet");
        }
        setActionError(errorText(c));
      }
    });

  const reject = () =>
    run(async () => {
      setActionError(null);
      try {
        await api("DELETE", path);
        setConfirm(null);
        app.announce(`Rejected ${domain.host}`);
        onClose();
        await refresh();
      } catch (e) {
        setConfirm(null);
        setActionError(errorText(code(e)));
      }
    });

  useHotkeys(
    {
      a: () => canApprove && void approve(),
      f: () => canFinish && void approve(),
      "shift+r": () => {
        if (canReject) setConfirm("reject");
      },
      "shift+d": () => {
        if (isOwner && domain.status !== "disabled") setConfirm("disable");
      },
    } satisfies Bindings<typeof DOMAIN_DETAIL_KEYS>,
    overlay === null && confirm === null,
  );

  const CONFIRMS: Record<Confirm, { title: string; text: string; ok: string; act: () => void }> = {
    case: {
      title: "Case-sensitive slugs",
      text: domain.caseSensitive
        ? `Turn off case-sensitive slugs for ${domain.host}? Slugs that differ only by case would clash, so this is refused while any exist.`
        : `Turn on case-sensitive slugs for ${domain.host}? /Menu and /menu become different links, and visits must use the exact spelling.`,
      ok: "Confirm",
      act: () => void toggleCase(),
    },
    disable: { title: "Disable domain", text: `Disable ${domain.host}? Its short links stop working until you enable it again.`, ok: "Disable", act: () => void disable() },
    reject: {
      title: "Reject domain",
      text: `Reject ${domain.host}? Its ${plural(domain.linkCount, "link")} ${domain.linkCount === 1 ? "is" : "are"} deleted. This cannot be undone.`,
      ok: "Reject",
      act: () => void reject(),
    },
    takeover: {
      title: "Send traffic to linkwarren",
      text: `${domain.status === "active" ? "Connect" : "Approve"} and send ${domain.host} traffic to linkwarren? It already has DNS records in your Cloudflare account.`,
      ok: "Send traffic",
      act: () => void approve(true),
    },
  };
  const dlg = confirm ? CONFIRMS[confirm] : null;

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void save();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setDraft(draftOf(domain));
      setErrors({});
      setFormError(null);
    }
  };

  const field = (id: string, label: string, key: "bare" | "nf") => (
    <>
      <div className="field">
        <label htmlFor={id}>{label}</label>
        <input id={id} className="input" value={draft[key]} readOnly={!canEdit} spellCheck={false} autoComplete="off" placeholder="Built-in page" aria-invalid={errors[key] ? true : undefined} onChange={(e) => set({ [key]: e.target.value })} />
      </div>
      {errors[key] && (
        <p className="err" role="alert">
          {errorText(errors[key]!)}
        </p>
      )}
    </>
  );

  return (
    <>
      <aside className="detail" aria-label="Selected domain" onKeyDown={onKeyDown}>
        <div className="d-head">
          <CloseButton label="Close domain details" onClick={onClose} />
          <div className="short">
            <span className="slug">{domain.host}</span>
          </div>
          <div className="row">
            <Tag tone={tag.tone}>{tag.label}</Tag>
            <span className="muted">Owner: {ownerLabel(domain, me, users)}</span>
          </div>
        </div>
        {domain.status === "pending" && (
          <div className="sect">
            <div className="callout wait">
              {isOwner
                ? `${domain.linkCount} links are already here. They show a "not active yet" page until you approve the domain.`
                : 'Links here show a "not active yet" page until the owner approves the domain.'}
            </div>
          </div>
        )}
        {loops > 0 && (
          <div className="sect">
            <div className="callout wait">
              {`${loopText(loops, domain.host)} `}
              <NavLink to={`/links?q=${encodeURIComponent(domain.host.slice(0, 48))}`}>{editThem(loops)}</NavLink>
            </div>
          </div>
        )}
        {showCf && view && (
          <div className="sect">
            <h3>Ownership and certificate</h3>
            <CfStatus view={view} />
            {poll.error && <p className="err">{errorText(poll.error)}</p>}
          </div>
        )}
        <CfControls key={domain.id} domain={{ ...domain, cloudflare: view ?? domain.cloudflare }} controlsEnabled={controlsEnabled} />
        <fieldset className="plain" disabled={!canEdit}>
          <div className="sect">
            <h3>When someone visits</h3>
            {field("dd-bare", "The bare domain", "bare")}
            {field("dd-nf", "A missing or deleted link", "nf")}
          </div>
          <div className="sect">
            <h3>Domain settings</h3>
            <div className="toggle">
              <div>
                Hide from search engines<small>Sends noindex on every redirect</small>
              </div>
              <Switch checked={draft.noindex} onChange={(noindex) => set({ noindex })} label="Hide from search engines" />
            </div>
            <div className="toggle">
              <div>
                Case-sensitive slugs<small>/Menu and /menu are different links</small>
              </div>
              <Switch
                checked={domain.caseSensitive}
                onChange={() => {
                  setCaseError(null);
                  setConfirm("case");
                }}
                label="Case-sensitive slugs"
              />
            </div>
            {caseError && (
              <p className="err" role="alert">
                {caseError}
              </p>
            )}
            <div className="field">
              <label htmlFor="dd-reserved">Reserved slugs</label>
              <input id="dd-reserved" className="input sans" value={draft.reserved} readOnly={!canEdit} spellCheck={false} autoComplete="off" aria-invalid={errors.reserved ? true : undefined} onChange={(e) => set({ reserved: e.target.value })} />
            </div>
            <p className="hint">+ {DEFAULT_RESERVED.length} defaults</p>
            {errors.reserved && (
              <p className="err" role="alert">
                {errorText(errors.reserved)}
              </p>
            )}
          </div>
        </fieldset>
        <MembersEditor domain={domain} />
        {(formError || actionError) && (
          <p className="err" role="alert">
            {formError ?? actionError}
          </p>
        )}
        {(canEdit || isOwner) && (
          <div className="actions">
            {canEdit && (
              <button type="button" className="btn primary" onClick={() => void save()} aria-keyshortcuts="Control+Enter">
                Save <span className="k">Ctrl Enter</span>
              </button>
            )}
            {canApprove && (
              <button type="button" className="btn" onClick={() => void approve()} aria-keyshortcuts="A">
                {domain.status === "disabled" ? "Enable domain" : "Approve domain"} <kbd>A</kbd>
              </button>
            )}
            {canFinish && (
              <button type="button" className="btn" onClick={() => void approve()} aria-keyshortcuts="F">
                Finish connecting <kbd>F</kbd>
              </button>
            )}
            {canReject && (
              <button type="button" className="btn" onClick={() => setConfirm("reject")} aria-keyshortcuts="Shift+R">
                Reject <kbd>Shift R</kbd>
              </button>
            )}
            {isOwner && domain.status !== "disabled" && (
              <button type="button" className="btn" onClick={() => setConfirm("disable")} aria-keyshortcuts="Shift+D">
                Disable <kbd>Shift D</kbd>
              </button>
            )}
          </div>
        )}
        <div className="foot">
          <span>Added {shortDate(domain.createdAt)}</span>
        </div>
      </aside>
      {dlg && (
        <Sheet label={dlg.title} onClose={() => setConfirm(null)}>
          <div className="sh-head">
            <h2>{dlg.title}</h2>
          </div>
          <div className="sh-body">
            <p>{dlg.text}</p>
            <div className="actions">
              {/* Takeover is hard to undo: focus starts on Cancel so a stray or held Enter cancels, and key autorepeat never confirms. */}
              <button type="button" className="btn primary" autoFocus={confirm !== "takeover"} onClick={dlg.act}
                onKeyDown={(e) => e.repeat && e.preventDefault()}>
                {dlg.ok} <span className="k">Enter</span>
              </button>
              <button type="button" className="btn" autoFocus={confirm === "takeover"} onClick={() => setConfirm(null)}>
                Cancel <kbd>Esc</kbd>
              </button>
            </div>
          </div>
        </Sheet>
      )}
    </>
  );
}
