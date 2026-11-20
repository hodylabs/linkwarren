import { Hono } from "hono";
import type { Env } from "./env";
import { normalizeHost } from "./host";
import { handleRedirect } from "./redirect";

const app = new Hono<{ Bindings: Env }>();

// Short hosts never serve app routes; only the dashboard host gets past this point.
app.use("*", async (c, next) => {
  if (normalizeHost(c.req.header("host") ?? new URL(c.req.url).host) !== normalizeHost(c.env.DASHBOARD_HOST)) {
    return handleRedirect(c.req.raw, c.env, Math.floor(Date.now() / 1000));
  }
  await next();
});

app.get("/healthz", (c) => c.json({ ok: true }));

export default app;
