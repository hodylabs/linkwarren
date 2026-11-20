import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// Run as `vite web` / `vite build web`, so the root is web/ and the output is web/dist.
export default defineConfig(({ mode }) => {
  // Dev only: a real Cloudflare Access app token for the local Worker (docs/development.md). Never a VITE_ variable, so it is never bundled.
  const token = loadEnv(mode, process.cwd(), "CF_ACCESS_").CF_ACCESS_TOKEN ?? "";
  return {
    plugins: [react()],
    build: { outDir: "dist", emptyOutDir: true },
    server: {
      fs: { allow: [".."] }, // the app imports pure validators from ../src (R8)
      proxy: {
        "/api": {
          target: "http://localhost:8787",
          changeOrigin: true,
          headers: { "cf-access-jwt-assertion": token, origin: "https://localhost" },
        },
      },
    },
  };
});
