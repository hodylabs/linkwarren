import { Hono } from "hono";
import { requireUser } from "./auth";
import type { Env } from "./env";
import type { UserRow } from "./types";
import { normalizeHost } from "./host";
import { handleRedirect } from "./redirect";
import { links, locks } from "./api/links";
import { domains } from "./api/domains";
import { importApi } from "./api/import";

const app = new Hono<{ Bindings: Env; Variables: { user: UserRow } }>();

// Short hosts never serve app routes; only the dashboard host gets past this point.
app.use("*", async (c, next) => {
  if (normalizeHost(c.req.header("host") ?? new URL(c.req.url).host) !== normalizeHost(c.env.DASHBOARD_HOST)) {
    return handleRedirect(c.req.raw, c.env, Math.floor(Date.now() / 1000), c.executionCtx);
  }
  await next();
});

app.use("/api/*", requireUser);
app.get("/api/me", (c) => c.json({ email: c.var.user.email, role: c.var.user.role }));

app.route("/api/domains", domains);
app.route("/api/links", links);
app.route("/api/locks", locks);
app.route("/api/import", importApi);

app.get("/healthz", (c) => c.json({ ok: true }));

export default app;
