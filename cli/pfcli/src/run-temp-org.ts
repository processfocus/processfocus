#!/usr/bin/env bun

import { spawnSync } from "node:child_process"
import { cpSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { NodeContext } from "@effect/platform-node"
import { Effect } from "effect"
import { runBuild } from "./commands/build"
import { runImport } from "./commands/import"

const workspaceRoot =
  process.env["NX_WORKSPACE_ROOT"] ?? resolve(import.meta.dir, "..", "..", "..")

const portFiles = [
  ".auth-port.json",
  ".graphql-port.json",
  ".frontend-port.json",
]

const usage = `Usage:
  bun cli/pfcli/src/run-temp-org.ts <org-path> --copy [-- <command> [args...]]
  bun cli/pfcli/src/run-temp-org.ts <org-path> --build [-- <command> [args...]]
  bun cli/pfcli/src/run-temp-org.ts <org-path> --import [-- <command> [args...]]
`

const runWithNodeContext = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(NodeContext.layer)) as Effect.Effect<A, E>,
  )

const parseArgs = (argv: string[]) => {
  const commandSeparatorIndex = argv.indexOf("--")
  const commandArgs =
    commandSeparatorIndex === -1 ? [] : argv.slice(commandSeparatorIndex + 1)
  const args =
    commandSeparatorIndex === -1 ? argv : argv.slice(0, commandSeparatorIndex)

  const orgPath = args[0]
  const mode =
    args[1] === "--copy"
      ? "copy"
      : args[1] === "--build"
        ? "build"
        : args[1] === "--import"
          ? "import"
          : undefined

  if (!orgPath || !mode || args.length !== 2) {
    throw new Error(usage)
  }

  return { orgPath, mode, commandArgs }
}

const main = async () => {
  const { orgPath, mode, commandArgs } = parseArgs(Bun.argv.slice(2))
  const sourceOrgPath = resolve(workspaceRoot, orgPath)
  const tempOrgPath = mkdtempSync(
    join(tmpdir(), `pf-temp-org-${basename(orgPath)}-`),
  )
  const originalCwd = process.cwd()
  const originalPfOrg = process.env["PF_ORG"]

  try {
    cpSync(sourceOrgPath, tempOrgPath, { recursive: true })
    if (mode === "copy") {
      rmSync(resolve(tempOrgPath, "db"), { recursive: true, force: true })
    }
    for (const portFile of portFiles) {
      rmSync(resolve(workspaceRoot, portFile), { force: true })
    }
    process.env["PF_ORG"] = tempOrgPath
    process.chdir(workspaceRoot)

    if (mode === "copy") {
      // The child command is responsible for any build/import bootstrap.
    } else if (mode === "build") {
      await runWithNodeContext(runBuild(tempOrgPath))
    } else {
      rmSync(resolve(tempOrgPath, "db"), { recursive: true, force: true })
      await runWithNodeContext(runImport(tempOrgPath))
    }

    if (commandArgs.length === 0) {
      return
    }

    const [command, ...commandRestArgs] = commandArgs
    if (!command) {
      return
    }

    const result = spawnSync(command, commandRestArgs, {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        PF_ORG: tempOrgPath,
        PF_TEMP_ORG_NODE_MODULES: resolve(workspaceRoot, "node_modules"),
      },
      stdio: "inherit",
    })

    if (result.error) {
      throw result.error
    }

    process.exitCode = result.status ?? 1
    return
  } finally {
    process.chdir(originalCwd)
    if (originalPfOrg === undefined) {
      delete process.env["PF_ORG"]
    } else {
      process.env["PF_ORG"] = originalPfOrg
    }
    rmSync(tempOrgPath, { recursive: true, force: true })
  }
}

await main()
