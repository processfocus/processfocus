#!/usr/bin/env bun

import { randomBytes } from "node:crypto"
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { Schema } from "effect"
import {
  assertDashboardBuild,
  dashboardDirectory,
  dashboardEnvironment,
  nextCommand,
  prepareDashboardBuild,
  recordDashboardBuild,
} from "./dashboard-build"

export interface LocalRuntimeOptions {
  readonly orgPath: string
  readonly runtimeRoot?: string
  readonly authPort?: number
  readonly graphqlPort?: number
  readonly dashboardPort?: number
  readonly dashboard?: boolean
  readonly build?: boolean
}

const CliPackageJson = Schema.Struct({
  bin: Schema.Struct({ pfcli: Schema.String }),
})

type RuntimeEnvironment = NodeJS.ProcessEnv & {
  readonly PF_RUNTIME_ROOT: string
}

const resolveCli = (): string => {
  const manifestPath = fileURLToPath(
    import.meta.resolve("@processfocus/cli/package.json"),
  )
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"))
  const { bin } = Schema.decodeUnknownSync(CliPackageJson)(manifest)
  return resolve(dirname(manifestPath), bin.pfcli)
}

const runCli = (
  cli: string,
  args: readonly string[],
  env: RuntimeEnvironment,
): string => {
  const result = Bun.spawnSync([process.execPath, cli, ...args], {
    cwd: env["PF_RUNTIME_ROOT"],
    env,
    stderr: "pipe",
    stdout: "pipe",
  })
  const stdout = result.stdout.toString().trim()
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString().trim() || stdout
    throw new Error(`pfcli ${args[0] ?? ""} failed: ${detail}`)
  }
  return stdout
}

const waitForHttp = async (url: string, init?: RequestInit): Promise<void> => {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(2000),
      })
      if (response.ok) {
        if (init?.method !== "POST") return
        const body: unknown = await response.json()
        if (
          typeof body === "object" &&
          body !== null &&
          "data" in body &&
          !("errors" in body)
        )
          return
      }
    } catch {
      // The child process may not have bound its port yet.
    }
    await Bun.sleep(100)
  }
  throw new Error(`Timed out waiting for ${url}`)
}

export const startLocalRuntime = async (
  options: LocalRuntimeOptions,
): Promise<number> => {
  const runtimeRoot = resolve(
    options.runtimeRoot ?? process.env["PF_RUNTIME_ROOT"] ?? process.cwd(),
  )
  const orgPath = resolve(runtimeRoot, options.orgPath)
  const authPort = options.authPort ?? 4020
  const graphqlPort = options.graphqlPort ?? 4000
  const dashboardPort = options.dashboardPort ?? 3000
  let authUrl = `http://localhost:${authPort}`
  let graphqlUrl = `http://localhost:${graphqlPort}/graphql`
  const dashboardUrl = `http://localhost:${dashboardPort}`
  const cli = resolveCli()
  const env: RuntimeEnvironment = {
    ...process.env,
    NODE_ENV: process.env["NODE_ENV"] ?? "development",
    PF_ORG: orgPath,
    PF_RUNTIME_ROOT: runtimeRoot,
    PF_CEDAR_ROOT: fileURLToPath(new URL("./resources/cedar", import.meta.url)),
    PF_GRAPHQL_SCHEMA_ROOT: fileURLToPath(
      new URL("./resources/graphql-schema", import.meta.url),
    ),
    BASE_URL: undefined,
    FRONTEND_BASE_URL: dashboardUrl,
    PF_LOCAL_FRONTEND_ORIGIN: dashboardUrl,
    AUTH_URL: authUrl,
    GRAPHQL_ENDPOINT: graphqlUrl,
    OAUTH_ISSUER_URL: authUrl,
    JWKS_URI: `${authUrl}/.well-known/jwks.json`,
    INTERNAL_API_SECRET:
      process.env["INTERNAL_API_SECRET"] ?? randomBytes(32).toString("hex"),
  }

  console.log(`Importing ${orgPath}`)
  runCli(cli, ["import", orgPath], env)

  const children: Bun.Subprocess[] = []
  const spawn = ({
    entry,
    args = [],
    cwd = runtimeRoot,
    childEnv = env,
    executable = process.execPath,
  }: {
    readonly entry: string
    readonly args?: readonly string[]
    readonly cwd?: string
    readonly childEnv?: NodeJS.ProcessEnv
    readonly executable?: string
  }) => {
    const child = Bun.spawn([executable, entry, ...args], {
      cwd,
      env: childEnv,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    })
    children.push(child)
    return child
  }

  let stopping = false
  const stop = () => {
    stopping = true
    for (const child of children) child.kill("SIGTERM")
  }
  const waitForPort = async (
    file: string,
    child: Bun.Subprocess,
  ): Promise<number> => {
    const schema = Schema.Struct({
      port: Schema.Number.pipe(Schema.int(), Schema.between(1, 65535)),
    })
    for (let attempt = 0; attempt < 150; attempt += 1) {
      if (stopping || child.exitCode !== null)
        throw new Error(`Service exited before writing ${file}`)
      const path = resolve(runtimeRoot, file)
      if (existsSync(path))
        return Schema.decodeUnknownSync(schema)(
          JSON.parse(readFileSync(path, "utf8")),
        ).port
      await Bun.sleep(100)
    }
    throw new Error(`Timed out waiting for ${file}`)
  }
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)

  try {
    rmSync(resolve(runtimeRoot, ".auth-port.json"), { force: true })
    const auth = spawn({
      entry: fileURLToPath(
        new URL("./authentication-server.mjs", import.meta.url),
      ),
      args: options.authPort === undefined ? [] : ["--port", String(authPort)],
    })
    authUrl = `http://localhost:${options.authPort ?? (await waitForPort(".auth-port.json", auth))}`
    env["OAUTH_ISSUER_URL"] = authUrl
    env["AUTH_URL"] = authUrl
    env["JWKS_URI"] = `${authUrl}/.well-known/jwks.json`
    await waitForHttp(env["JWKS_URI"])
    writeFileSync(
      resolve(runtimeRoot, ".auth-port.json"),
      JSON.stringify({ port: Number(new URL(authUrl).port) }),
    )

    runCli(cli, ["refresh-frontend-jwt", orgPath], env)
    env["FRONTEND_JWT_TOKEN"] = runCli(cli, ["get-frontend-jwt", orgPath], env)

    rmSync(resolve(runtimeRoot, ".graphql-port.json"), { force: true })
    const graphql = spawn({
      entry: fileURLToPath(new URL("./graphql-server.mjs", import.meta.url)),
      args: [
        ...(options.graphqlPort === undefined
          ? []
          : ["--port", String(graphqlPort)]),
        "--org",
        orgPath,
      ],
    })
    graphqlUrl = `http://localhost:${options.graphqlPort ?? (await waitForPort(".graphql-port.json", graphql))}/graphql`
    env["GRAPHQL_ENDPOINT"] = graphqlUrl
    await waitForHttp(graphqlUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env["FRONTEND_JWT_TOKEN"]}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ query: "query RuntimeReadiness { __typename }" }),
    })

    writeFileSync(
      resolve(runtimeRoot, ".graphql-port.json"),
      JSON.stringify({ port: Number(new URL(graphqlUrl).port) }),
    )

    if (options.build) {
      const app = prepareDashboardBuild(env)
      const build = spawn({
        entry: nextCommand(),
        args: ["build"],
        cwd: app,
        childEnv: dashboardEnvironment(env),
        executable: "node",
      })
      const result = await Promise.race(
        children.map(async (child) => ({ child, code: await child.exited })),
      )
      if (result.child !== build || result.code !== 0)
        throw new Error(
          "Dashboard build or supporting service failed; see output above",
        )
      await recordDashboardBuild(env)
      console.log(`Dashboard built in ${app}`)
      return 0
    }

    spawn({
      entry: fileURLToPath(new URL("./job-worker.mjs", import.meta.url)),
      args: ["--org", orgPath],
    })
    spawn({
      entry: cli,
      args: ["import", "--watch", "--watch-skip-initial", orgPath],
    })

    if (options.dashboard !== false) {
      await assertDashboardBuild(env)
      env["PORT"] = String(dashboardPort)
      env["HOSTNAME"] = "127.0.0.1"
      writeFileSync(
        resolve(runtimeRoot, ".frontend-port.json"),
        `${JSON.stringify({ port: dashboardPort })}\n`,
      )
      spawn({
        entry: nextCommand(),
        args: [
          "start",
          "--port",
          String(dashboardPort),
          "--hostname",
          "127.0.0.1",
        ],
        cwd: dashboardDirectory(runtimeRoot),
        childEnv: dashboardEnvironment(env),
        executable: "node",
      })
      await waitForHttp(`${dashboardUrl}/_pf/health`)
    }

    console.log(
      options.dashboard === false
        ? "Process Focus local runtime services are ready"
        : `Process Focus local runtime is ready at ${dashboardUrl}`,
    )
    return await Promise.race(children.map((child) => child.exited))
  } finally {
    stop()
    const killTimer = setTimeout(() => {
      for (const child of children)
        if (child.exitCode === null) child.kill("SIGKILL")
    }, 5000)
    await Promise.all(children.map((child) => child.exited))
    clearTimeout(killTimer)
    process.off("SIGINT", stop)
    process.off("SIGTERM", stop)
  }
}

if (import.meta.main) {
  try {
    const parsed = parseArgs({
      args: process.argv.slice(2),
      options: {
        org: { type: "string", short: "o" },
        "auth-port": { type: "string" },
        "graphql-port": { type: "string" },
        "dashboard-port": { type: "string" },
        "no-dashboard": { type: "boolean" },
        build: { type: "boolean" },
      },
      strict: true,
      allowPositionals: false,
    })
    const orgPath = parsed.values.org ?? process.env["PF_ORG"]
    if (!orgPath) throw new Error("--org is required (or set PF_ORG)")
    const port = (name: "auth-port" | "graphql-port" | "dashboard-port") => {
      const value = parsed.values[name]
      if (value === undefined) return undefined
      const parsedPort = Number(value)
      if (
        !Number.isInteger(parsedPort) ||
        parsedPort < 1 ||
        parsedPort > 65535
      ) {
        throw new Error(`--${name} must be a valid port`)
      }
      return parsedPort
    }
    const authPort = port("auth-port")
    const graphqlPort = port("graphql-port")
    const dashboardPort = port("dashboard-port")
    process.exitCode = await startLocalRuntime({
      orgPath,
      ...(authPort === undefined ? {} : { authPort }),
      ...(graphqlPort === undefined ? {} : { graphqlPort }),
      ...(dashboardPort === undefined ? {} : { dashboardPort }),
      build: parsed.values.build === true,
      dashboard: parsed.values["no-dashboard"] !== true,
    })
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
