import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { APP_VERSION } from "./vite.config";

// Web tests run in jsdom, never in the Workers pool. Run from the repo root: `vitest run -c web/vitest.config.ts`.
export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(APP_VERSION) },
  test: {
    environment: "jsdom",
    include: ["web/src/**/*.test.{ts,tsx}"],
    unstubGlobals: true,
    setupFiles: ["web/src/test/setup.ts"],
  },
});
