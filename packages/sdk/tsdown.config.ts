import { defineConfig } from "tsdown"

export default defineConfig({
  tsconfig: "tsconfig.lib.json",
  entry: [
    "src/index.ts",
    "src/auth.ts",
    "src/calendar.ts",
    "src/forms.ts",
    "src/manifest.ts",
    "src/plugin.ts",
    "src/testing.ts",
  ],
  format: "esm",
  dts: false,
  clean: true,
  sourcemap: false,
  deps: {
    alwaysBundle: [/^@pf\//],
    neverBundle: [
      "@processfocus/runtime",
      "constructs",
      "effect",
      "graphology",
      "react",
      "validator",
    ],
    onlyImport: [
      "@processfocus/runtime",
      "constructs",
      "effect",
      "graphology",
      "react",
      "validator",
    ],
  },
})
