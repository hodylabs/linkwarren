import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          // Dummy values: real ones live in wrangler.instance.jsonc.
          bindings: {
            TEST_MIGRATIONS: migrations,
            DASHBOARD_HOST: "dash.test",
            // The S1 suites run in access mode; app-mode tests set AUTH_MODE = "app" themselves.
            AUTH_MODE: "access",
            ACCESS_TEAM_DOMAIN: "team.example.cloudflareaccess.com",
            ACCESS_AUD: "test-aud",
            OWNER_EMAIL: "owner@example.com",
            EMAIL_FROM: "links@example.com",
            RESEND_API_KEY: "re_test",
            CF_CNAME_TARGET: "edge.test",
          },
          // Test-only stand-in for the Workers static-assets binding (real one is instance config).
          serviceBindings: {
            ASSETS: async (req: Request) => {
              const { pathname } = new URL(req.url);
              const hit = (body: string, type: string) =>
                new Response(req.method === "HEAD" ? null : body, { headers: { "content-type": type, "x-fake-assets": "1" } });
              if (pathname === "/") return hit("<!doctype html><title>lw</title>", "text/html; charset=utf-8");
              if (pathname === "/assets/app.js") return hit("export {}", "text/javascript");
              return new Response("not found", { status: 404, headers: { "x-fake-assets": "1" } });
            },
          },
        },
      }),
    ],
    test: { include: ["test/**/*.test.ts"], setupFiles: ["./test/apply-migrations.ts"] },
  };
});
