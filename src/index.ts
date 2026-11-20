import { Hono } from "hono";
import type { Env } from "./env";
import { normalizeHost } from "./host";

const app = new Hono<{ Bindings: Env }>();

// Short hosts never serve app routes; only the dashboard host gets past this point.
app.use("*", async (c, next) => {
  if (normalizeHost(c.req.header("host") ?? new URL(c.req.url).host) !== normalizeHost(c.env.DASHBOARD_HOST)) {
    return c.text("Not found", 404); // placeholder until the redirect handler lands
  }
  await next();
});

app.get("/healthz", (c) => c.json({ ok: true }));

export default app;
