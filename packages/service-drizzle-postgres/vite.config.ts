/// <reference types='vitest' />

import { nxReadySignal } from "@nx/vite/plugins/nx-ready-signal.plugin"
import { defineConfig } from "vite"

export default defineConfig(() => ({
  root: import.meta.dirname,
  cacheDir: "../../node_modules/.vite/packages/service-drizzle-postgres",
  plugins: [nxReadySignal()],
  test: {
    name: "@pf/service-drizzle-postgres",
    watch: false,
    globals: true,
    environment: "node",
    include: ["test/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"],
    reporters: ["default"],
    coverage: {
      reportsDirectory: "./test-output/vitest/coverage",
      provider: "v8" as const,
    },
  },
}))
