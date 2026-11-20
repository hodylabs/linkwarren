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
            ACCESS_TEAM_DOMAIN: "team.example.cloudflareaccess.com",
            ACCESS_AUD: "test-aud",
            OWNER_EMAIL: "owner@example.com",
          },
        },
      }),
    ],
    test: { setupFiles: ["./test/apply-migrations.ts"] },
  };
});
