import { spawnSync } from "node:child_process"
import { join } from "node:path"

export const buildDevelopmentEnv = (
  workspaceRoot: string,
  sourceEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv => ({
  ...sourceEnv,
  NX_WORKSPACE_ROOT: workspaceRoot,
})

const run = async (): Promise<number> => {
  const workspaceRoot = process.env["NX_WORKSPACE_ROOT"] ?? process.cwd()
  const frontendRoot = join(workspaceRoot, "apps", "frontend")
  const env = buildDevelopmentEnv(workspaceRoot, process.env)
  const preparation = spawnSync(
    "bash",
    [join(frontendRoot, "scripts", "prepare-build-inputs.sh")],
    { cwd: workspaceRoot, env, stdio: "inherit" },
  )
  if (preparation.error) throw preparation.error
  if (preparation.status !== 0) return preparation.status ?? 1

  const child = Bun.spawn(["bun", "run", "--bun", "next", "dev"], {
    cwd: frontendRoot,
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })

  const forwardSignal = (signal: NodeJS.Signals) => {
    try {
      child.kill(signal)
    } catch {
      // Child may already have exited.
    }
  }
  process.on("SIGINT", () => forwardSignal("SIGINT"))
  process.on("SIGTERM", () => forwardSignal("SIGTERM"))
  return child.exited
}

if (import.meta.main) {
  process.exitCode = await run()
}
