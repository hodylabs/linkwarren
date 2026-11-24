import { forwardRef, useImperativeHandle } from "react";
import type { Domain, Link, LinkStats } from "../api";
import { linkPage } from "../analytics/Breakdowns";
import { NavLink } from "../router";
import { CloseButton, Icon, Tag } from "../shell/ui";
import { useApp } from "../state";
import { clock, shortDate } from "../time";
import { fullName, type VCard } from "../../../src/vcard";
import { DestText } from "./DestText";
import { readUtm } from "./compose";
import { creatorLabel, forwardTarget, linkState, shortUrl, type StatsLive } from "./linkView";
import { routeSummary } from "./rules";
import { photoSrc } from "./photo";
import { SharePanel } from "./SharePanel";

export type DetailHandle = { copy(): void };

const LIVE_HINT = { off: "Live clicks are off on this instance.", unavailable: "Recent clicks could not be loaded." } as const;
const PHONE_LABEL = { cell: "Mobile", work: "Work", home: "Home", other: "Other" } as const;

/** When the link is live: a start and an end, either, or none. */
function schedule(l: Link): string {
  const s = l.startsAt !== null ? `Starts ${clock(l.startsAt)}` : "";
  const e = l.expiresAt !== null ? `Ends ${clock(l.expiresAt)}` : "";
  return [s, e].filter(Boolean).join(", ") || "Always on";
}

/** A contact card as read-only text: photo or initials, name, title, then phones, emails, websites and the address. */
function CardSummary({ card }: { card: Partial<VCard> & Pick<VCard, "firstName" | "lastName" | "org" | "title" | "phones" | "emails" | "websites" | "address"> }) {
  const name = fullName(card as VCard);
  const sub = [card.title, card.org].filter(Boolean).join(", ");
  const initials = (name || "?").split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  const a = card.address;
  const address = [a.street, a.city, a.region, a.postalCode, a.country].filter(Boolean).join(", ");
  return (
    <>
      <div className="contact">
        {card.photo ? <img className="vc-img" src={photoSrc(card.photo)} alt="Contact photo" /> : <span className="photo" aria-hidden="true">{initials}</span>}
        <div>
          <b>{name}</b>
          {sub && <div className="muted">{sub}</div>}
        </div>
      </div>
      {(card.phones.length > 0 || card.emails.length > 0 || card.websites.length > 0 || address) && (
        <ul className="rows" aria-label="Card details">
          {card.phones.map((p, i) => <li key={`p${i}`}><Icon name="phone" />{p.number}<small>{PHONE_LABEL[p.type]}</small></li>)}
          {card.emails.map((e, i) => <li key={`e${i}`}><Icon name="mail" />{e}</li>)}
          {card.websites.map((w, i) => <li key={`w${i}`}><Icon name="globe" />{w}</li>)}
          {address && <li><Icon name="pin" />{address}</li>}
        </ul>
      )}
      {card.note && <p className="muted vc-note">{card.note}</p>}
    </>
  );
}

/**
 * The selected link's summary panel. It never edits: Edit (E) opens the same sheet as New link. Copy (C), QR code (Q) and
 * Link analytics (A) sit under the slug; Delete at the bottom.
 */
export const LinkDetail = forwardRef<DetailHandle, {
  link: Link; stats: LinkStats | undefined; live: StatsLive; domain: Domain | undefined; canEdit: boolean;
  onEdit(): void; onQr(): void; onDelete(): void; onClose(): void; onOpenTarget(): void;
}>(function LinkDetail({ link, stats, live, domain, canEdit, onEdit, onQr, onDelete, onClose, onOpenTarget }, ref) {
  const app = useApp();
  const host = domain?.host ?? "";
  const copy = () => {
    if (!host) return app.announce("Cannot copy: this link's domain is unknown");
    navigator.clipboard.writeText(shortUrl(host, link.slug)).then(
      () => app.announce("Copied"),
      () => app.announce("Could not copy"),
    );
  };
  useImperativeHandle(ref, () => ({ copy }));
  const state = linkState(link, domain, Math.floor(Date.now() / 1000));
  const isCard = link.kind === "vcard";
  const who = (id: string) => creatorLabel(id, app.me, app.users);
  const created = who(link.createdBy);
  const utm = readUtm(link.url);
  const tags = (["source", "medium", "campaign"] as const).filter((k) => utm[k]).map((k) => `utm_${k}=${utm[k]}`).join(" · ");
  const opens = link.forwardTo ? (
    <>Forwards to {forwardTarget(link)}</>
  ) : isCard ? (
    <>Downloads {link.vcard ? `${fullName(link.vcard as VCard)}'s` : "a"} contact card</>
  ) : (
    <>
      <DestText url={link.url} />
      {link.redirectCode === 301 && <span className="faint"> (301 fixed)</span>}
    </>
  );

  return (
    <aside className="detail" aria-label="Selected link">
      <div className="d-head">
        <CloseButton label="Close link details" onClick={onClose} />
        {/* S12: the name, when set, is the title; the short link sits under it. */}
        {link.name && <div className="title lname">{link.name}</div>}
        <div className={link.name ? "short sub" : "short"}>
          <span className="host">{host}/</span>
          <span className="slug">{link.slug}</span>
        </div>
        <div className="row">
          <Tag tone={state.tone}>{state.label}</Tag>
          {isCard && <span className="fact"><Icon name="card" />Contact card</span>}
        </div>
        <div className="row">
          <button type="button" className="btn sm" onClick={copy} disabled={!host} aria-keyshortcuts="C">
            <Icon name="copy" />Copy<kbd>C</kbd>
          </button>
          {canEdit && !link.forwardTo && (
            <button type="button" className="btn sm" onClick={onEdit} aria-keyshortcuts="E">
              <Icon name="edit" />Edit<kbd>E</kbd>
            </button>
          )}
          {host && !link.forwardTo && (
            <button type="button" className="btn sm" onClick={onQr} aria-keyshortcuts="Q">
              <Icon name="qr" />QR code<kbd>Q</kbd>
            </button>
          )}
          {!link.forwardTo && (
            <NavLink className="btn sm" to={linkPage(link.id)} aria-keyshortcuts="A">
              <Icon name="chart" />Link analytics<kbd>A</kbd>
            </NavLink>
          )}
        </div>
      </div>
      <div className="sect">
        <dl className="facts">
          <dt>Opens</dt>
          <dd>{opens}</dd>
          {tags && (
            <>
              <dt>Campaign</dt>
              <dd data-testid="campaign-tags">Campaign tags: {tags}</dd>
            </>
          )}
          <dt>Created</dt>
          <dd>{created === "You" ? "You" : created}, {shortDate(link.createdAt)}</dd>
          <dt>Updated</dt>
          <dd>{who(link.updatedBy)}, {clock(link.updatedAt)}</dd>
        </dl>
      </div>
      {link.forwardTo ? (
        <div className="sect">
          <p className="hint">This old address was kept when its link moved. Visitors are forwarded to {forwardTarget(link)}, where the click is counted.</p>
          <button type="button" className="btn sm" onClick={onOpenTarget}>
            <Icon name="fwd" />Open the link it forwards to
          </button>
        </div>
      ) : (
        <>
          {stats && (
            <div className="sect">
              <h3>Last 7 days</h3>
              <div className="stats">
                <div className="stat"><b>{stats.clicks.toLocaleString("en-US")}</b><small>clicks</small></div>
                <div className="stat"><b>{stats.clicks > 0 ? Math.round((100 * stats.qr) / stats.clicks) : 0}%</b><small>from QR</small></div>
                <div className="stat"><b>{stats.topCountry ?? "None"}</b><small>top country</small></div>
              </div>
              {live !== "ok" && <p className="hint">{LIVE_HINT[live]} These counts leave out yesterday and today.</p>}
            </div>
          )}
          {isCard && link.vcard && (
            <div className="sect">
              <h3>Contact card</h3>
              <CardSummary card={link.vcard as VCard} />
            </div>
          )}
          <div className="sect">
            <h3>Rules</h3>
            <dl className="facts">
              <dt>Schedule</dt>
              <dd>{schedule(link)}</dd>
              {!isCard && (
                <>
                  <dt>Password</dt>
                  <dd>{link.hasPassword ? "Set" : "None"}</dd>
                  <dt>Routing</dt>
                  <dd>{link.routes.length ? routeSummary(link.routes) : "None"}</dd>
                  <dt>Query string</dt>
                  <dd>{link.passQuery ? "Passed through" : "Dropped"}</dd>
                </>
              )}
            </dl>
          </div>
          {canEdit && <SharePanel scope="link" id={link.id} />}
        </>
      )}
      {canEdit && (
        <div className="actions">
          <button type="button" className="btn sm danger" onClick={onDelete} aria-keyshortcuts="Shift+D">
            <Icon name="trash" />Delete link<kbd>Shift D</kbd>
          </button>
        </div>
      )}
    </aside>
  );
});
