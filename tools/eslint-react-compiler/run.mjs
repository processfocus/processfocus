/**
 * Resolve the workspace-local eslint binary from this package so the gate does
 * not depend on PATH, bunx downloads, or root hoisting. That also keeps
 * eslint's nested ajv@6 install (draft-04) isolated from monorepo packages
 * that need ajv@8 (for example @pf/form).
 */
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"

const require = createRequire(import.meta.url)
const eslintPackageJson = require.resolve("eslint/package.json")
const eslintBin = join(dirname(eslintPackageJson), "bin", "eslint.js")
const result = spawnSync(
  process.execPath,
  [eslintBin, ...process.argv.slice(2)],
  {
    stdio: "inherit",
  },
)

process.exit(result.status === null ? 1 : result.status)
