import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { rm } from "node:fs/promises"
import { resolve } from "node:path"
import { prepareLifecycleOrganisation } from "../support/lifecycle-fixture"

const root = resolve(import.meta.dir, "../../..")
const args = process.argv
  .slice(2)
  .filter((arg, index) => index !== 0 || arg !== "--")
const [command, ...rest] = args
if (!command)
  throw new Error(
    "Expected a command to run against the disposable lifecycle organisation",
  )
const org = await prepareLifecycleOrganisation(root)
try {
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(command, rest, {
      cwd: root,
      env: {
        ...process.env,
        PF_ORG: org,
        PF_TEMP_ORG_NODE_MODULES: `${root}/node_modules`,
        E2E_SKIP_DELAYS: "false",
        // All separately launched services must share the callback credential.
        // Without it GraphQL rejects worker events and the Dashboard stays stale.
        INTERNAL_API_SECRET:
          process.env["INTERNAL_API_SECRET"] ?? randomBytes(32).toString("hex"),
      },
      stdio: "inherit",
    })
    child.on("error", reject)
    child.on("exit", (code) => resolve(code ?? 1))
  })
  process.exitCode = code
} finally {
  await rm(org, { recursive: true, force: true })
}
