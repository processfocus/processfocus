import { defineConfig } from "vitest/config"

// Package-local `vitest run` commands walk up to this file; only enable the
// workspace project list when Vitest is launched from the repository root.
const isWorkspaceRoot = process.cwd() === import.meta.dirname

export default defineConfig({
  test: isWorkspaceRoot
    ? {
        projects: [
          "**/vite.config.{mjs,js,ts,mts}",
          "**/vitest.config.{mjs,js,ts,mts}",
          "!vitest.config.{mjs,js,ts,mts}",
        ],
      }
    : {},
})
