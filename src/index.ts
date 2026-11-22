import { Hono, type MiddlewareHandler } from "hono";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import { authMode, requireUser } from "./auth";
import type { Env } from "./env";
import type { SessionRef, UserRow } from "./types";
import { normalizeHost } from "./host";
import { handleRedirect } from "./redirect";
import { links, locks } from "./api/links";
import { domains } from "./api/domains";
import { importApi } from "./api/import";
import { users } from "./api/users";
import { audit } from "./api/audit";
import { analytics } from "./api/analytics";
import { settings } from "./api/settings";
import { serveDashboard } from "./assets";
import { signin } from "./api/signin";
import { account } from "./api/account";
import { scheduled } from "./cron";
import { blocked, hit, LIMITS, limitKey } from "./limits";
import { isOAuthPath, provider } from "./oauth";
import { ipPrefix } from "./session";

export const app = new Hono<{ Bindings: Env; Variables: { user: UserRow; session: SessionRef | null } }>();

// Missing config fails closed with a clear error instead of a throw.
app.use("*", async (c, next) => {
  if (!c.env.DASHBOARD_HOST?.trim()) return c.json({ error: "misconfigured" }, 500);
  await next();
});

// Short hosts never serve app routes; only the dashboard host gets past this point.
app.use("*", async (c, next) => {
  if (normalizeHost(c.req.header("host") ?? new URL(c.req.url).host) !== normalizeHost(c.env.DASHBOARD_HOST)) {
    return handleRedirect(c.req.raw, c.env, Math.floor(Date.now() / 1000), c.executionCtx);
  }
  await next();
});

// Own sign-in routes exist only in app mode (R2, R3): access mode answers 404, an unknown mode fails closed.
// Registered before the /api/* chain so requireUser never runs on /auth/* and /api/account/* is 404 before any auth check.
const appModeOnly: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const mode = authMode(c.env);
  if (!mode) return c.json({ error: "misconfigured" }, 500);
  if (mode !== "app") return c.json({ error: "not_found" }, 404);
  await next();
};
app.use("/auth/*", appModeOnly);
app.use("/api/account/*", appModeOnly);
app.route("/auth", signin);

// API responses carry identity and private data: never cache them anywhere.
app.use("/api/*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});

// CSRF: the Origin check plus the credential's own scope are the defence (app mode: the host-only SameSite=Lax session
// cookie; access mode: the Access JWT); the JSON-only 415 guard is best-effort.
// A missing Origin is allowed for non-browser clients.
const dashboardOrigin = (host: string) => `https://${normalizeHost(host)}`;
app.use("/api/*", (c, next) => csrf({ origin: dashboardOrigin(c.env.DASHBOARD_HOST) })(c, next));
app.use("/api/*", async (c, next) => {
  if (/^(GET|HEAD|OPTIONS)$/.test(c.req.method)) return next();
  const origin = c.req.header("origin");
  if (origin !== undefined && origin !== dashboardOrigin(c.env.DASHBOARD_HOST)) return c.json({ error: "forbidden_origin" }, 403);
  // Decide "has a body" from headers: browsers send content-length: 0 on bodyless DELETE/POST, and Workers then expose a non-null empty stream.
  const hasBody = Number(c.req.header("content-length") ?? 0) > 0 || c.req.header("transfer-encoding") !== undefined;
  if (hasBody && !/^application\/json\s*(;|$)/i.test(c.req.header("content-type") ?? ""))
    return c.json({ error: "unsupported_media_type" }, 415);
  await next();
});
app.use("/api/*", requireUser);
app.get("/api/me", async (c) => {
  const mode = authMode(c.env); // non-null: requireUser refused a bad mode already
  const me = { id: c.var.user.id, email: c.var.user.email, name: c.var.user.name, role: c.var.user.role, authMode: mode };
  if (mode !== "app") return c.json(me);
  const n = await c.env.DB.prepare("SELECT COUNT(*) n FROM passkeys WHERE user_id = ?").bind(c.var.user.id).first<{ n: number }>();
  return c.json({ ...me, passkeys: n?.n ?? 0 });
});

app.route("/api/domains", domains);
app.route("/api/links", links);
app.route("/api/locks", locks);
app.route("/api/import", importApi);
app.route("/api/users", users);
app.route("/api/audit", audit);
app.route("/api/analytics", analytics);
app.route("/api/settings", settings);
app.route("/api/account", account);

app.get("/healthz", (c) => c.json({ ok: true }));

// Dashboard files: GET/HEAD only, never under /api (unknown API paths stay JSON 404).
app.on(["GET", "HEAD"], ["/", "/*"], async (c) => {
  const p = c.req.path; // decoded, what Hono routes on: /%61pi/x must not slip past the /api check
  if (p === "/api" || p.startsWith("/api/")) return c.json({ error: "not_found" }, 404);
  return await serveDashboard(c.req.raw, c.env);
});

app.notFound((c) => c.json({ error: "not_found" }, 404));
app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  console.error("unhandled error", String(err));
  return c.json({ error: "internal" }, 500);
});

const notFound = () => Response.json({ error: "not_found" }, { status: 404 });

/** POST /register spends a KV write: D1 limits per IP range and per UTC day, reads first so a refused call writes nothing. */
async function registerLimited(req: Request, env: Env): Promise<Response | null> {
  const ipKey = limitKey.reg(ipPrefix(req.headers.get("cf-connecting-ip")));
  try {
    if (
      (await blocked(env, ipKey, LIMITS.reg)) ||
      (await blocked(env, limitKey.regDay, LIMITS.regDay)) ||
      !(await hit(env, ipKey, LIMITS.reg)) ||
      !(await hit(env, limitKey.regDay, LIMITS.regDay))
    )
      return Response.json({ error: "rate_limited" }, { status: 429, headers: { "retry-after": "3600" } });
  } catch {
    return Response.json({ error: "unavailable" }, { status: 503 }); // fail closed: no limiter, no registration
  }
  return null;
}

/** OAuth front door. Short hosts and a misconfigured instance never reach the provider; the app answers them. */
export async function wrapper(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!env.DASHBOARD_HOST?.trim()) return app.fetch(req, env, ctx);
  const url = new URL(req.url);
  if (normalizeHost(req.headers.get("host") ?? url.host) !== normalizeHost(env.DASHBOARD_HOST)) return app.fetch(req, env, ctx);
  const p = url.pathname;
  if (isOAuthPath(p)) {
    if (env.MCP_ENABLED !== "1") return notFound();
    // The library serves only the RFC 9728 suffix form; the bare form gets the same metadata, never the dashboard HTML.
    if (p === "/.well-known/oauth-protected-resource") return provider(env).fetch(new Request(new URL("/.well-known/oauth-protected-resource/mcp", url), req), env, ctx);
    if (p === "/register" && req.method === "POST") {
      const limited = await registerLimited(req, env);
      if (limited) return limited;
    }
  }
  return provider(env).fetch(req, env, ctx);
}

export default { fetch: wrapper, scheduled } satisfies ExportedHandler<Env>;
