import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";

// The app version shown at the bottom of the rail, from the root package.json.
export const APP_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;

// Run as `vite web` / `vite build web`, so the root is web/ and the output is web/dist.
export default defineConfig(({ mode }) => {
  // Dev only: a real Cloudflare Access app token for the local Worker (docs/development.md). Never a VITE_ variable, so it is never bundled.
  const token = loadEnv(mode, process.cwd(), "CF_ACCESS_").CF_ACCESS_TOKEN ?? "";
  return {
    // Relative URLs: one build serves host mode and path mode; the Worker roots them per mode in the shell (S8c R11).
    base: "./",
    plugins: [react()],
    define: { __APP_VERSION__: JSON.stringify(APP_VERSION) },
    // No data: URIs: the CSP is font-src/img-src self, so an inlined font would be blocked.
    build: { outDir: "dist", emptyOutDir: true, assetsInlineLimit: 0 },
    server: {
      fs: {
        allow: [".."], // the app imports pure validators from ../src (R8)
        // Replaces Vite's default deny list, so it repeats it and adds the Worker's local secrets and instance config.
        deny: [".env", ".env.*", "*.{crt,pem}", "**/.git/**", ".dev.vars*", "wrangler.instance.jsonc"],
      },
      proxy: {
        "/api": {
          target: "http://localhost:8787",
          changeOrigin: true,
          headers: { "cf-access-jwt-assertion": token },
          configure: (proxy) => {
            // Only the dev page itself is presented as the dashboard origin. Any other Origin (another site posting here)
            // passes through unchanged, so the Worker's CSRF check refuses it in local dev too.
            proxy.on("proxyReq", (proxyReq, req) => {
              if (req.headers.origin === `http://${req.headers.host}`) proxyReq.setHeader("origin", "https://localhost");
            });
          },
        },
      },
    },
  };
});
