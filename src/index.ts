import { Hono } from "hono";
import type { Env } from "./env";

const app = new Hono<{ Bindings: Env }>();

// Short hosts never serve app routes; only the dashboard host gets past this point.
// Task 3 replaces the lowercase compare with normalizeHost.
app.use("*", async (c, next) => {
  if (new URL(c.req.url).hostname.toLowerCase() !== c.env.DASHBOARD_HOST.toLowerCase()) {
    return c.text("Not found", 404); // placeholder until the redirect handler lands
  }
  await next();
});

app.get("/healthz", (c) => c.json({ ok: true }));

export default app;
