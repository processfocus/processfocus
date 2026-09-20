/**
 * Cross-platform launcher for `@processfocus/runtime-local:serve`.
 *
 * Resolves FRONTEND_JWT_TOKEN via pfcli and optionally passes --port when
 * FRONTEND_PORT is set, without POSIX shell env assignment or bash parameter
 * expansion (Windows cmd/PowerShell compatible).
 */

import { spawnSync } from "node:child_process"
import { join, resolve } from "node:path"

export const resolveWorkspaceRoot = (
  env: NodeJS.ProcessEnv = process.env,
  launcherDir: string = import.meta.dir,
): string => env["NX_WORKSPACE_ROOT"] ?? resolve(launcherDir, "..", "..", "..")

/**
 * Build argv for `bun run --bun next dev`, adding `--port` only when
 * FRONTEND_PORT is a non-empty string.
 */
export const buildNextDevArgv = (
  frontendPort: string | undefined,
): readonly string[] => {
  const argv = ["run", "--bun", "next", "dev"] as const
  if (frontendPort === undefined || frontendPort === "") {
    return [...argv]
  }
  return [...argv, "--port", frontendPort]
}

const resolveFrontendJwtToken = (
  workspaceRoot: string,
  env: NodeJS.ProcessEnv,
): string => {
  const pfcliMain = join(workspaceRoot, "cli", "pfcli", "src", "main.ts")
  const result = spawnSync("bun", [pfcliMain, "get-frontend-jwt"], {
    cwd: workspaceRoot,
    encoding: "utf8",
    env,
  })

  if (result.error) {
    throw result.error
  }

  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim()
    const stdout = (result.stdout ?? "").trim()
    const detail = stderr || stdout || `exit code ${String(result.status)}`
    throw new Error(`Failed to resolve FRONTEND_JWT_TOKEN: ${detail}`)
  }

  const token = (result.stdout ?? "").trim()
  if (token === "") {
    throw new Error("get-frontend-jwt returned an empty token")
  }

  return token
}

const prepareFrontendBuildInputs = (
  workspaceRoot: string,
  env: NodeJS.ProcessEnv,
): void => {
  const result = spawnSync(
    "bash",
    [join(workspaceRoot, "apps/frontend/scripts/prepare-build-inputs.sh")],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
      env,
    },
  )
  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = (result.stderr ?? result.stdout ?? "").trim()
    throw new Error(
      `Failed to prepare frontend build inputs: ${detail || `exit code ${String(result.status)}`}`,
    )
  }
}

export const buildFrontendEnv = (
  workspaceRoot: string,
  token: string,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv => ({
  ...env,
  NX_WORKSPACE_ROOT: workspaceRoot,
  FRONTEND_JWT_TOKEN: token,
})

const runServeFrontend = async (
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> => {
  const workspaceRoot = resolveWorkspaceRoot(env)
  const frontendRoot = join(workspaceRoot, "apps", "frontend")
  const token = resolveFrontendJwtToken(workspaceRoot, env)
  const argv = buildNextDevArgv(env["FRONTEND_PORT"])
  const frontendEnv = buildFrontendEnv(workspaceRoot, token, env)
  prepareFrontendBuildInputs(workspaceRoot, frontendEnv)

  const child = Bun.spawn(["bun", ...argv], {
    cwd: frontendRoot,
    env: frontendEnv,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })

  // Forward cancellation so `next dev` is not left orphaned when nx/Playwright
  // stops this launcher (especially important on Windows process-tree teardown).
  const forwardSignal = (signal: NodeJS.Signals) => {
    try {
      child.kill(signal)
    } catch {
      // Child may already have exited.
    }
  }
  const onSigInt = () => forwardSignal("SIGINT")
  const onSigTerm = () => forwardSignal("SIGTERM")
  process.on("SIGINT", onSigInt)
  process.on("SIGTERM", onSigTerm)

  try {
    return await child.exited
  } finally {
    process.off("SIGINT", onSigInt)
    process.off("SIGTERM", onSigTerm)
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await runServeFrontend()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(message)
    process.exitCode = 1
  }
}
