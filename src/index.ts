import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import { requireUser } from "./auth";
import type { Env } from "./env";
import type { UserRow } from "./types";
import { normalizeHost } from "./host";
import { handleRedirect } from "./redirect";
import { links, locks } from "./api/links";
import { domains } from "./api/domains";
import { importApi } from "./api/import";
import { users } from "./api/users";
import { audit } from "./api/audit";
import { serveDashboard } from "./assets";

const app = new Hono<{ Bindings: Env; Variables: { user: UserRow } }>();

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

// API responses carry identity and private data: never cache them anywhere.
app.use("/api/*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});

// CSRF: the Origin check plus the Access JWT are the defence; the JSON-only 415 guard is best-effort.
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
app.get("/api/me", (c) => c.json({ id: c.var.user.id, email: c.var.user.email, name: c.var.user.name, role: c.var.user.role }));

app.route("/api/domains", domains);
app.route("/api/links", links);
app.route("/api/locks", locks);
app.route("/api/import", importApi);
app.route("/api/users", users);
app.route("/api/audit", audit);

app.get("/healthz", (c) => c.json({ ok: true }));

// Dashboard files: GET/HEAD only, never under /api (unknown API paths stay JSON 404).
app.on(["GET", "HEAD"], ["/", "/*"], async (c) => {
  const p = new URL(c.req.url).pathname;
  if (p === "/api" || p.startsWith("/api/")) return c.json({ error: "not_found" }, 404);
  return await serveDashboard(c.req.raw, c.env);
});

app.notFound((c) => c.json({ error: "not_found" }, 404));
app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  console.error("unhandled error", String(err));
  return c.json({ error: "internal" }, 500);
});

export default app;
