import { Hono, type MiddlewareHandler } from "hono";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import { authMode, requireUser } from "./auth";
import type { Env } from "./env";
import type { SessionRef, UserRow } from "./types";
import type { Grant } from "./principal";
import { dash } from "./dash";
import { normalizeHost } from "./host";
import { handleRedirect } from "./redirect";
import { links, locks } from "./api/links";
import { domains } from "./api/domains";
import { importApi } from "./api/import";
import { users } from "./api/users";
import { roles } from "./api/roles";
import { invites } from "./api/invites";
import { audit } from "./api/audit";
import { analytics } from "./api/analytics";
import { instance, settings, setup } from "./api/settings";
import { serveDashboard } from "./assets";
import { signin } from "./api/signin";
import { account } from "./api/account";
import { keys } from "./api/keys";
import { agents } from "./api/agents";
import { exportApi } from "./api/export";
import { qrCodes } from "./api/qrcodes";
import { nonJsonBody } from "./api/shared";
import { isV1, v1 } from "./api/v1";
import { authorize } from "./mcp/authorize";

export const app = new Hono<{ Bindings: Env; Variables: { user: UserRow; session: SessionRef | null; grant: Grant } }>();

// Missing config fails closed with a clear error instead of a throw.
app.use("*", async (c, next) => {
  if (!dash(c.env)) return c.json({ error: "misconfigured" }, 500);
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
  // The logo is the one private, briefly cacheable response (R7); it sets its own header.
  if (c.req.path !== "/api/instance/logo") c.header("Cache-Control", "no-store");
});

// CSRF: the Origin check plus the credential's own scope are the defence (app mode: the host-only SameSite=Lax session
// cookie; access mode: the Access JWT); the JSON-only 415 guard is best-effort.
// A missing Origin is allowed for non-browser clients.
// The machine API (R3, R4) is mounted first and answers every /api/v1 path itself (unknown ones 404); these dashboard
// middlewares skip it anyway, so a Bearer request can never pick up the session user or FULL_GRANT.
app.route("/api/v1", v1);
const dashboardOrigin = (host: string) => `https://${normalizeHost(host)}`;
app.use("/api/*", (c, next) => (isV1(c.req.path) ? next() : csrf({ origin: dashboardOrigin(c.env.DASHBOARD_HOST) })(c, next)));
app.use("/api/*", async (c, next) => {
  if (isV1(c.req.path) || /^(GET|HEAD|OPTIONS)$/.test(c.req.method)) return next();
  const origin = c.req.header("origin");
  if (origin !== undefined && origin !== dashboardOrigin(c.env.DASHBOARD_HOST)) return c.json({ error: "forbidden_origin" }, 403);
  if (nonJsonBody(c.req)) return c.json({ error: "unsupported_media_type" }, 415);
  await next();
});
app.use("/api/*", (c, next) => (isV1(c.req.path) ? next() : requireUser(c, next)));
app.get("/api/me", async (c) => {
  const mode = authMode(c.env); // non-null: requireUser refused a bad mode already
  const u = c.var.user;
  const me = { id: u.id, email: u.email, name: u.name, role: u.role, roleId: u.roleId, roleName: u.roleName, perms: u.perms, authMode: mode };
  if (mode !== "app") return c.json(me);
  const n = await c.env.DB.prepare("SELECT COUNT(*) n FROM passkeys WHERE user_id = ?").bind(c.var.user.id).first<{ n: number }>();
  return c.json({ ...me, passkeys: n?.n ?? 0 });
});

app.route("/api/domains", domains);
app.route("/api/links", links);
app.route("/api/locks", locks);
app.route("/api/import", importApi);
app.route("/api/users", invites);
app.route("/api/users", users);
app.route("/api/roles", roles);
app.route("/api/audit", audit);
app.route("/api/analytics", analytics);
app.route("/api/settings", settings);
app.route("/api/setup", setup);
app.route("/api/instance", instance);
app.route("/api/account", account);
app.route("/api/keys", keys);
app.route("/api/agents", agents);
app.route("/api/export", exportApi);
app.route("/api/qr-codes", qrCodes);

app.get("/healthz", (c) => c.json({ ok: true }));

// OAuth consent (MCP agents). Reached only through the wrapper, which 404s it while agent connections are off.
app.route("/authorize", authorize);

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
