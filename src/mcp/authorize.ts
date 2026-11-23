import { Hono } from "hono";
import { AuthorizationError, authorizationErrorRedirect, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { auditStmt } from "../audit";
import { authenticate, authMode } from "../auth";
import { dash } from "../dash";
import type { Env } from "../env";
import { hitAll, LIMITS, limitKey } from "../limits";
import { actorCan, can } from "../roles";
import { safeNext } from "../session";
import { mcpState } from "./switch";
import { messagePage, renderApproval } from "./approval-page";

/**
 * A client name safe to show and to store as audit `via`: whitespace collapsed, control and format (bidi, zero-width)
 * characters removed, at most 40 code points, else "Unnamed client". DCR names are self-asserted: never trust them further.
 */
export function cleanClientName(raw: unknown): string {
  if (typeof raw !== "string") return "Unnamed client";
  const s = raw.replace(/\s+/gu, " ").replace(/[\p{Cc}\p{Cf}]/gu, "").replace(/ {2,}/g, " ").trim();
  return [...s].slice(0, 40).join("").trim() || "Unnamed client";
}

const CSP = (formAction: string) =>
  `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`;

/** The library's consent headers (binding cookie and all) first, then ours on top. */
function html(body: string | null, status: number, o: { csp?: string; lib?: Headers; location?: string } = {}): Response {
  const h = new Headers();
  o.lib?.forEach((v, k) => { if (k !== "set-cookie") h.set(k, v); });
  for (const c of o.lib?.getSetCookie() ?? []) h.append("set-cookie", c);
  if (body !== null) h.set("Content-Type", "text/html; charset=utf-8");
  h.set("Cache-Control", "no-store");
  h.set("X-Frame-Options", "DENY");
  h.set("X-Content-Type-Options", "nosniff");
  // Pages: same-origin, because no-referrer makes browsers post the approve form with Origin: null (refused below).
  // Redirects to the client: no-referrer, so the client never sees the consent URL.
  h.set("Referrer-Policy", o.location ? "no-referrer" : "same-origin");
  h.set("Content-Security-Policy", o.csp ?? CSP("'none'"));
  if (o.location) h.set("Location", o.location);
  return new Response(body, { status, headers: h });
}
const msg = (status: number, title: string, text: string) => html(messagePage(title, text), status);

// The S2 Gate copy for each sign-in refusal.
const REFUSALS = {
  unauthenticated: ["Signed out", "You are signed out. Reload the page to sign in."],
  not_invited: ["Not invited", "This email is not invited to this linkwarren. Ask the owner to invite you."],
  disabled: ["Access turned off", "Your access has been turned off. Ask the owner."],
} as const;

/** S8 R7: the person's role lacks `agents`; refused before any limiter or consent write. */
const NO_AGENTS = () => msg(403, "Not allowed", "Your role does not allow connecting AI agents.");
const EXPIRED = () => msg(400, "Approval expired", "Approval expired, start again from your agent");

type Ctx = { Bindings: Env };
export const authorize = new Hono<Ctx>();

// The wrapper's switch gate sees the raw path, Hono routes on the decoded one (/%61uthorize): gate here too (same helper),
// and serve only the canonical path.
authorize.use("*", async (c, next) => {
  let on: boolean;
  try {
    on = (await mcpState(c.env)).on;
  } catch {
    return c.json({ error: "unavailable" }, 503); // fail closed
  }
  if (!on || new URL(c.req.url).pathname !== "/authorize") return c.json({ error: "not_found" }, 404);
  await next();
});

/** Who is signed in right now, or the refusal page (same status as the API would give). */
async function who(req: Request, env: Env) {
  if (!authMode(env)) return { fail: msg(500, "Misconfigured", "This linkwarren is misconfigured.") };
  const r = await authenticate(req, env);
  if ("status" in r) {
    const [t, m] = REFUSALS[r.error];
    return { fail: msg(r.status, t, m), status: r.status };
  }
  return { user: r.user };
}

const helpers = (env: Env): OAuthHelpers | null => env.OAUTH_PROVIDER ?? null;

/** The library falls back to the client id when a client gave no name; that is not a name to show or audit. */
const nameOf = (d: { clientName: string; clientId: string }) => cleanClientName(d.clientName === d.clientId ? undefined : d.clientName);
/** I3: 10 consent requests per person per hour, one atomic statement so a refused one writes nothing; no limiter, no consent. */
async function limitedFor(env: Env, userId: string): Promise<Response | null> {
  const k = limitKey.authz(userId);
  try {
    if (!(await hitAll(env, [{ key: k, limit: LIMITS.authz }])).ok)
      return msg(429, "Too many attempts", "Too many connection attempts. Try again in an hour.");
  } catch {
    return msg(503, "Unavailable", "Connecting agents is unavailable right now.");
  }
  return null;
}

const FAILED = () => msg(500, "Something went wrong", "The connection could not be finished. Start again from your agent.");

authorize.get("/", async (c) => {
  // Each page spends a KV write: only a top-level navigation may open it, never a cross-site <img>, frame or fetch.
  const dest = c.req.header("sec-fetch-dest");
  if (dest !== undefined && dest !== "document") return msg(403, "Refused", "Open this page in your browser from your agent.");
  const w = await who(c.req.raw, c.env);
  if (!w.user) {
    if (w.status === 401 && authMode(c.env) === "app") {
      const u = new URL(c.req.url);
      // `u` is the inner request (prefix stripped), so `next` is an inner path (R9); the sign-in page lives under the prefix.
      const prefix = dash(c.env)?.prefix ?? "";
      const next = safeNext(u.pathname + u.search, u.origin, prefix);
      return html(null, 302, { location: `${prefix}/sign-in?next=${encodeURIComponent(next)}` });
    }
    return w.fail;
  }
  if (!can(w.user, "agents")) return NO_AGENTS();
  const oauth = helpers(c.env);
  if (!oauth) return msg(503, "Unavailable", "Connecting agents is unavailable right now.");
  const limited = await limitedFor(c.env, w.user.id);
  if (limited) return limited;
  let req;
  try {
    req = await oauth.parseAuthRequest(c.req.raw);
  } catch (e) {
    // Once the client and its redirect are validated the library gives the error redirect (state and RFC 9207 iss);
    // before that it must stay local.
    if (e instanceof AuthorizationError && e.redirectTo) return html(null, 302, { location: e.redirectTo });
    return msg(400, "Invalid request", "Invalid authorization request");
  }
  // B4: the library only forces PKCE on public clients; require S256 for every client.
  if (!req.codeChallenge || req.codeChallengeMethod !== "S256")
    return html(null, 302, { location: authorizationErrorRedirect(req, "invalid_request", "PKCE with S256 is required") });
  let d;
  try {
    d = await oauth.describeConsent(req);
  } catch {
    return msg(400, "Unknown client", "Unknown client");
  }
  const { handle, headers } = await oauth.beginConsent(req);
  const page = renderApproval({
    clientName: nameOf(d),
    redirectHost: d.redirectHost,
    redirectIsLoopback: d.redirectIsLoopback,
    who: { email: w.user.email, role: w.user.role },
    uid: w.user.id,
    handle,
    prefix: dash(c.env)?.prefix ?? "",
  });
  // The approve/deny answer is a redirect to the client: form-action must allow its origin (registration allowlists it).
  return html(page, 200, { lib: headers, csp: CSP(`'self' ${new URL(d.redirectUri).origin}`) });
});

authorize.post("/", async (c) => {
  const origin = dash(c.env)?.origin; // no path: the same origin in both modes (R8)
  if (!origin || c.req.header("origin") !== origin) return msg(403, "Refused", "This form must be sent from linkwarren itself.");
  // The grant goes to whoever is signed in at POST time; never a user id from the form.
  const w = await who(c.req.raw, c.env);
  if (!w.user) return w.fail;
  const user = w.user;
  const oauth = helpers(c.env);
  if (!oauth) return msg(503, "Unavailable", "Connecting agents is unavailable right now.");
  const limited = await limitedFor(c.env, user.id);
  if (limited) return limited;
  let form: Record<string, unknown>;
  try {
    form = await c.req.parseBody();
  } catch {
    return EXPIRED();
  }
  const handle = typeof form.handle === "string" ? form.handle : "";
  // The page names the person it was shown to; a different person signed in since then starts again (handle not spent).
  if (form.uid !== user.id) return EXPIRED();

  if (form.action === "deny") {
    try {
      const d = await oauth.denyConsent(c.req.raw, handle);
      return html(null, 302, { lib: d.headers, location: d.redirectTo });
    } catch {
      return EXPIRED();
    }
  }
  if (form.action !== "approve") return EXPIRED();
  // After deny, so a refused person's agent still gets the standard access_denied redirect.
  if (!can(user, "agents")) return NO_AGENTS();

  const write = form.access === "write";
  const del = write && form.del === "1";
  const scope = ["offline_access", "read", ...(write ? ["write"] : []), ...(del ? ["delete"] : [])];
  let approved;
  try {
    approved = await oauth.approveConsent(c.req.raw, handle, { scope });
  } catch {
    return EXPIRED();
  }
  const { request } = approved;
  const connId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  let clientName: string;
  const ok = actorCan(user.id, "agents");
  try {
    const d = await oauth.describeConsent(request);
    clientName = nameOf(d);
    // The role's agents is re-checked inside the insert: a role edit after the check above leaves no row, audit or grant.
    const res = await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO agent_connections (id, user_id, client_id, client_name, redirect_host, can_write, can_delete, created_at) SELECT ?,?,?,?,?,?,?,? WHERE ${ok.sql}`,
      ).bind(connId, user.id, request.clientId, clientName, d.redirectHost, write ? 1 : 0, del ? 1 : 0, now, ...ok.binds),
      auditStmt(c.env, {
        actorId: user.id, via: clientName, action: "agent.connect", targetType: "agent_connection", targetId: connId,
        detail: { clientId: request.clientId, redirectHost: d.redirectHost, write, del },
      }, { sql: "EXISTS (SELECT 1 FROM agent_connections WHERE id = ?)", binds: [connId] }),
    ]);
    if (!res[0]!.meta.changes) return NO_AGENTS();
  } catch (err) {
    console.error("connection write failed", err instanceof Error ? err.name : "unknown");
    return FAILED();
  }
  try {
    const { redirectTo } = await oauth.completeAuthorization({
      request, userId: user.id, scope, props: { userId: user.id, connId }, metadata: { connId, clientName },
    });
    // The library revoked this person's older grants for the client (revokeExistingGrants default), only now that the
    // new grant is stored; D1 follows. Older rows only (rowid), so of two racing approvals the newer one stays.
    await c.env.DB.prepare(
      "UPDATE agent_connections SET revoked_at = ? WHERE user_id = ? AND client_id = ? AND revoked_at IS NULL AND rowid < (SELECT rowid FROM agent_connections WHERE id = ?)",
    ).bind(now, user.id, request.clientId, connId).run()
      .catch((e: unknown) => console.error("older connection revoke failed", e instanceof Error ? e.name : "unknown")); // their grants are gone already
    return html(null, 302, { lib: approved.headers, location: redirectTo });
  } catch (err) {
    console.error("completeAuthorization failed", err instanceof Error ? err.name : "unknown");
    // No grant exists: revoke the row and mark the connect audit as undone in one batch.
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE agent_connections SET revoked_at = ? WHERE id = ?").bind(now, connId),
      auditStmt(c.env, { actorId: user.id, via: clientName, action: "agent.disconnect", targetType: "agent_connection", targetId: connId, detail: { reason: "failed" } },
        { sql: "EXISTS (SELECT 1 FROM agent_connections WHERE id = ?)", binds: [connId] }),
    ]).catch((e: unknown) => console.error("revoke after failure failed", e instanceof Error ? e.name : "unknown"));
    return FAILED();
  }
});
