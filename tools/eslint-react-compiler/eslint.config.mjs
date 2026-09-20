/**
 * Focused React Compiler / Rules-of-React diagnostics only.
 *
 * Biome remains the formatter and general lint authority. This config exists
 * solely to surface `eslint-plugin-react-hooks` recommended diagnostics
 * (including React Compiler rules) for console client surfaces.
 *
 * Invoke via project targets, not as a repo-wide ESLint stack:
 *   bun scripts/nx-quiet.ts run @pf/cloud-org-console:lint-react-compiler
 *   bun scripts/nx-quiet.ts run @pf/usage-costs:lint-react-compiler
 */
import { defineConfig } from "eslint/config"
import reactHooks from "eslint-plugin-react-hooks"
import tseslint from "typescript-eslint"

export default defineConfig([
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/out-tsc/**",
      "**/dist/**",
      "**/test-output/**",
      "**/lib/generated/**",
      "**/generated/**",
      "**/*.{test,spec}.{ts,tsx,js,jsx}",
      // Server-only Next route handlers and app wiring without React hooks.
      "**/app/api/**",
      "**/app/**/route.ts",
      "**/instrumentation*.ts",
      "**/proxy.ts",
      "**/codegen.ts",
      "**/next.config.ts",
      "**/postcss.config.mjs",
    ],
  },
  // TypeScript parsing only — do not enable typescript-eslint style rules.
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
  },
  // Keep the recommended preset unwrapped so future preset fields are preserved.
  reactHooks.configs.flat.recommended,
])
