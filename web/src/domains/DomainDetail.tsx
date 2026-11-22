import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { api, ApiError, type Domain } from "../api";
import { errorText } from "../copy";
import { rebase } from "../draft";
import { useHotkeys, type Bindings } from "../keys";
import { Sheet } from "../shell/Sheet";
import { CloseButton, Switch, Tag } from "../shell/ui";
import { useApp } from "../state";
import { DEFAULT_RESERVED } from "../../../src/validate";
import { shortDate } from "../time";
import { MembersEditor } from "./MembersEditor";
import { canManage, domainDiff, draftOf, ownerLabel, statusTag, type Draft } from "./domainView";

type Confirm = "case" | "disable";

/** Domain detail hotkeys (owner) and their text on the shortcuts sheet. */
export const DOMAIN_DETAIL_KEYS = {
  a: "Approve or enable the selected domain (owner)",
  "shift+d": "Disable the selected domain (owner)",
} as const;
const code = (e: unknown) => (e instanceof ApiError ? e.code : "internal");

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
  const busy = useRef(false); // one write at a time: a double Enter or click sends once
  const tag = statusTag(domain, isOwner);
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

  const post = (verb: "approve" | "disable") =>
    run(async () => {
      setActionError(null);
      try {
        await api("POST", `/api/domains/${encodeURIComponent(domain.id)}/${verb}`);
        setConfirm(null);
        app.announce(verb === "approve" ? "Domain enabled" : "Domain disabled");
        await refresh();
      } catch (e) {
        setConfirm(null);
        setActionError(errorText(code(e)));
      }
    });

  const canApprove = isOwner && domain.status !== "active";
  useHotkeys(
    {
      a: () => canApprove && void post("approve"),
      "shift+d": () => {
        if (isOwner && domain.status !== "disabled") setConfirm("disable");
      },
    } satisfies Bindings<typeof DOMAIN_DETAIL_KEYS>,
    overlay === null && confirm === null,
  );

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
              <button type="button" className="btn" onClick={() => void post("approve")} aria-keyshortcuts="A">
                {domain.status === "disabled" ? "Enable domain" : "Approve domain"} <kbd>A</kbd>
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
      {confirm && (
        <Sheet label={confirm === "case" ? "Case-sensitive slugs" : "Disable domain"} onClose={() => setConfirm(null)}>
          <div className="sh-head">
            <h2>{confirm === "case" ? "Case-sensitive slugs" : "Disable domain"}</h2>
          </div>
          <div className="sh-body">
            <p>
              {confirm === "disable"
                ? `Disable ${domain.host}? Its short links stop working until you enable it again.`
                : domain.caseSensitive
                  ? `Turn off case-sensitive slugs for ${domain.host}? Slugs that differ only by case would clash, so this is refused while any exist.`
                  : `Turn on case-sensitive slugs for ${domain.host}? /Menu and /menu become different links, and visits must use the exact spelling.`}
            </p>
            <div className="actions">
              <button type="button" className="btn primary" autoFocus onClick={() => void (confirm === "case" ? toggleCase() : post("disable"))}>
                {confirm === "disable" ? "Disable" : "Confirm"} <span className="k">Enter</span>
              </button>
              <button type="button" className="btn" onClick={() => setConfirm(null)}>
                Cancel <kbd>Esc</kbd>
              </button>
            </div>
          </div>
        </Sheet>
      )}
    </>
  );
}
