import { buildReport, loadRows, resolveRange } from "./analytics";
import { escapeHtml } from "./email";
import type { Env } from "./env";
import { hit, LIMITS, limitKey } from "./limits";
import { CSS, doc, PAGE_HEADERS } from "./pages";
import { ipPrefix, sha256Hex } from "./session";

/**
 * S13 R7: the read-only share page at <dashboard>/share/<token>. Server-rendered, no script, aggregates only (totals, the last
 * 30 days and the top countries, referrers and devices; never link lists, recent clicks or anything per visitor).
 * The token is 32 random bytes in base64url; only its SHA-256 is stored, so the lookup is by hash and needs no constant-time compare.
 * Every failure (bad shape, unknown, revoked, creator no longer active, link or domain gone, link moved off the domain) is the same 404.
 */

export const SHARE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const newShareToken = (): string => b64url(crypto.getRandomValues(new Uint8Array(32)));
export const shareHash = (token: string): Promise<string> => sha256Hex(token);

const TOP = 10;
const HEADERS = { ...PAGE_HEADERS, "x-robots-tag": "noindex, nofollow", "referrer-policy": "no-referrer" } as const;
const ok = (html: string) => new Response(html, { status: 200, headers: { ...HEADERS, "cache-control": "private, max-age=60" } });
const fail = (status: 404 | 429 | 503, title: string, msg: string) =>
  new Response(doc(title, CSS, `<h1>${title}</h1><p>${msg}</p>`), { status, headers: { ...HEADERS, "cache-control": "no-store" } });
const notFound = () => fail(404, "Not found", "This share link does not exist or was turned off.");

const WIDE =
  CSS +
  `main{max-width:720px;text-align:left}.sub{margin:0 0 14px;font-size:14px}.tot{display:flex;gap:8px;margin:0 0 14px}` +
  `.tot div{flex:1;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--inset)}.tot b{display:block;font-size:20px}` +
  `.tot small,.foot,.note{color:var(--muted);font-size:13px}.chart{display:block;width:100%;height:120px;margin:4px 0 12px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}` +
  `h2{margin:0 0 4px;font-size:14px;font-weight:600}table{width:100%;border-collapse:collapse;font-size:14px}` +
  `td{padding:3px 0;border-top:1px solid var(--line)}td.n{text-align:right;font-variant-numeric:tabular-nums}` +
  `.foot{margin:14px 0 0}.note{margin:0 0 12px}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}`;

const fmt = (n: number) => n.toLocaleString("en-US");
const e = escapeHtml;
type Row = { value: string; clicks: number };
const table = (title: string, rows: Row[], empty: string, blank = "Unknown") =>
  `<section><h2>${e(title)}</h2>` +
  (rows.length ? `<table>${rows.map((r) => `<tr><td>${e(r.value || blank)}</td><td class="n">${fmt(r.clicks)}</td></tr>`).join("")}</table>` : `<p class="note">${e(empty)}</p>`) +
  `</section>`;

/** Clicks per day as an inline SVG line over a soft fill, like the dashboard chart; plain markup, so the no-script CSP holds. */
export function lineChart(clicks: number[]): string {
  const W = 600, H = 120, pad = 6, n = clicks.length;
  if (n < 2) return "";
  const top = Math.max(1, ...clicks);
  const pts = clicks.map((c, i) => `${((i / (n - 1)) * (W - 2 * pad) + pad).toFixed(1)} ${(H - pad - (c / top) * (H - 2 * pad)).toFixed(1)}`);
  const line = `M${pts.join(" L")}`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Clicks per day, highest ${fmt(top)}">` +
    `<path d="${line} L${W - pad} ${H - pad} L${pad} ${H - pad} Z" fill="#FD8D27" fill-opacity=".14"/>` +
    `<path d="${line}" fill="none" stroke="#FD8D27" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>`;
}

type Share = { scope: "link" | "domain"; scope_id: string; domain_id: string; host: string; link_domain: string | null; slug: string | null; name: string | null };

export async function sharePage(req: Request, env: Env, token: string, nowSec = Math.floor(Date.now() / 1000)): Promise<Response> {
  // Rate limit first, so guessing tokens is as slow as reading pages.
  try {
    if (!(await hit(env, limitKey.share(ipPrefix(req.headers.get("cf-connecting-ip"))), LIMITS.share))) return fail(429, "Too many requests", "Wait a minute and try again.");
  } catch {
    return fail(503, "Unavailable", "This page is unavailable right now."); // fail closed: no limiter, no page
  }
  if (!SHARE_TOKEN.test(token)) return notFound();
  const s = await env.DB.prepare(
    `SELECT s.scope, s.scope_id, s.domain_id, d.host, l.domain_id AS link_domain, l.slug, l.name
     FROM share_links s JOIN users u ON u.id = s.created_by AND u.status = 'active' JOIN domains d ON d.id = s.domain_id
     LEFT JOIN links l ON s.scope = 'link' AND l.id = s.scope_id
     WHERE s.token_hash = ? AND s.revoked_at IS NULL`,
  ).bind(await shareHash(token)).first<Share>();
  if (!s || (s.scope === "link" && s.link_domain !== s.domain_id)) return notFound(); // deleted (no row) or moved off the domain
  const range = resolveRange({ range: "30" }, nowSec);
  if ("error" in range) return notFound();
  const scope = { domainIds: [s.domain_id], linkIds: s.scope === "link" ? [s.scope_id] : null };
  const rows = await loadRows(env, range, scope, nowSec);
  const r = buildReport(range, rows, new Map([[s.domain_id, s.host]]), { truncated: false, visitors: false });
  const address = s.scope === "link" ? `${s.host}/${s.slug}` : s.host;
  const title = s.scope === "link" && s.name ? s.name : address;
  const perDay = r.series.map((d) => d.qr + d.typed);
  const days = [...r.series].reverse().map((d) => ({ value: d.bucket, clicks: d.qr + d.typed })).filter((d) => d.clicks > 0);
  const live = rows.live === "ok" ? "" : `<p class="note">Clicks from the last day or two are not available right now, so the newest days may show fewer.</p>`;
  const main =
    `<h1>${e(title)}</h1><p class="sub"><span class="mono">${e(address)}</span>, clicks from ${e(r.from)} to ${e(r.to)} (UTC days)</p>` +
    `<div class="tot"><div><b>${fmt(r.totals.clicks)}</b><small>clicks</small></div><div><b>${fmt(r.totals.qr)}</b><small>from QR codes</small></div>` +
    `<div><b>${fmt(r.totals.typed)}</b><small>typed or clicked</small></div></div>${live}${lineChart(perDay)}` +
    `<div class="grid">${table("Days with clicks", days, "No clicks yet.")}${table("Top countries", r.countries.slice(0, TOP), "No clicks yet.")}` +
    `${table("Top referrers", r.referrers.slice(0, TOP), "No referrers yet.", "Direct")}${table("Devices", r.devices.slice(0, TOP), "No clicks yet.")}</div>` +
    `<p class="foot">A read-only share from linkwarren: totals only, no visitor details.</p>`;
  return ok(doc(e(title), WIDE, main));
}
