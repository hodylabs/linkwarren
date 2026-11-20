import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Web tests run in jsdom, never in the Workers pool. Run from the repo root: `vitest run -c web/vitest.config.ts`.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["web/src/**/*.test.{ts,tsx}"],
    unstubGlobals: true,
    setupFiles: ["web/src/test/setup.ts"],
  },
});
