import { execFile, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { cp, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { promisify } from "node:util"

const root = resolve(__dirname, "../../..")
const frontend = join(root, "apps/frontend")
const run = promisify(execFile)

async function localPort() {
  const server = createServer()
  server.listen(0, "localhost")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("No local port")
  await new Promise<void>((done) => server.close(() => done()))
  return address.port
}

/** One mutable organisation, issuer, queue and Dashboard cache per Playwright worker. */
export async function withRegularRuntime(
  use: (url: string) => Promise<void>,
): Promise<void> {
  const org = await mkdtemp(join(tmpdir(), "pf-temp-org-demo-"))
  const services = new Map<
    string,
    { child: ReturnType<typeof spawn>; closed: Promise<void> }
  >()
  try {
    const [port, auth, gql] = await Promise.all([
      localPort(),
      localPort(),
      localPort(),
    ])
    const url = `http://localhost:${port}`
    const issuer = `http://localhost:${auth}`
    const graphql = `http://localhost:${gql}`
    const env = {
      ...process.env,
      BASE_URL: "",
      NODE_ENV: "development",
      PF_ORG: org,
      SQLITE_DATABASE_PATH: join(org, "db/pf.db"),
      PF_TEMP_ORG_NODE_MODULES: join(root, "node_modules"),
      PF_RUNTIME_ROOT: org,
      PF_LOCAL_FRONTEND_ORIGIN: url,
      FRONTEND_BASE_URL: url,
      OAUTH_ISSUER_URL: issuer,
      AUTH_URL: issuer,
      JWKS_URI: `${issuer}/.well-known/jwks.json`,
      GRAPHQL_ENDPOINT: `${graphql}/graphql`,
      GRAPHQL_SERVER_URL: graphql,
      PF_RUNTIME_MODE: "local",
      PF_AUTH_MODE: "local-dummy",
      PF_BYPASS_AUTH: "",
      INTERNAL_API_SECRET: randomUUID(),
      REVALIDATE_SECRET: randomUUID(),
    }
    // Never copy a developer's database. Import the same MCP-extended demo
    // as the serial suite, with this worker's real WebAuthn origin.
    const demo = join(root, "examples/demo")
    await cp(demo, org, {
      recursive: true,
      filter: (path) =>
        path !== join(demo, "db") && path !== join(demo, "dist"),
    })
    const cli = join(root, "cli/pfcli/src/main.ts")
    await run(
      "bun",
      [
        "apps/frontend-e2e/scripts/with-mcp-list-fixture.ts",
        "--",
        "bun",
        cli,
        "import",
        org,
      ],
      { env, cwd: root },
    )
    const { stdout } = await run("bun", [cli, "get-frontend-jwt", org], {
      env,
      cwd: root,
    })
    const token = stdout.trim()
    const start = async (
      name: string,
      cmd: string,
      args: string[],
      extra: NodeJS.ProcessEnv = {},
    ) => {
      const child = spawn(cmd, args, {
        cwd: org,
        env: { ...env, ...extra },
        stdio: "ignore",
      })
      const closed = new Promise<void>((done) =>
        child.once("close", () => done()),
      )
      services.set(name, { child, closed })
      await once(child, "spawn")
    }
    const service = (name: string, ...args: string[]) =>
      start(name, "bun", [
        join(root, `runtime/local/src/${name}/${name}.ts`),
        ...args,
      ])
    await Promise.all(
      Object.entries({ auth, graphql: gql, frontend: port }).map(
        ([name, port]) =>
          writeFile(join(org, `.${name}-port.json`), JSON.stringify({ port })),
      ),
    )
    await Promise.all([
      service("authentication-server", "--port", String(auth)),
      service("graphql-server", "--port", String(gql), "--org", org),
      service("job-worker", "--org", org),
    ])

    // Only the compiled inputs are shared. Next's ISR and fetch caches are writable.
    const app = join(org, "dashboard")
    await cp(join(frontend, ".next/standalone/apps/frontend"), app, {
      recursive: true,
      filter: (path) =>
        !path.endsWith("/node_modules") && !path.endsWith("/public"),
    })
    await symlink(join(frontend, "node_modules"), join(app, "node_modules"))
    await symlink(
      join(frontend, ".next/node_modules"),
      join(app, ".next/node_modules"),
    )
    await symlink(join(frontend, ".next/static"), join(app, ".next/static"))
    await symlink(join(frontend, "public"), join(app, "public"))
    await start("Dashboard", "node", [join(app, "server.js")], {
      NODE_ENV: "production",
      FRONTEND_JWT_TOKEN: token,
      HOSTNAME: "127.0.0.1",
      PORT: String(port),
    })
    const deadline = Date.now() + 60_000
    while (true) {
      for (const [name, { child }] of services)
        if (!child.pid || child.exitCode !== null || child.signalCode)
          throw new Error(
            `Regular E2E ${name} exited during startup (${child.signalCode ?? child.exitCode})`,
          )
      if (Date.now() > deadline)
        throw new Error("Regular E2E startup timed out")
      // A generic build has prerendered login metadata for the build issuer.
      const response = await fetch(`${url}/api/revalidate`, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
        headers: {
          "content-type": "application/json",
          cookie: `access_token_${port}=${token}`,
        },
        body: JSON.stringify({
          path: "/login",
          tag: "login-page",
          secret: env.REVALIDATE_SECRET,
        }),
      }).catch(() => undefined)
      if (response?.ok) break
      await delay(150)
    }
    // Step helpers discover the worker's services through its own port files.
    process.env["PF_RUNTIME_ROOT"] = org
    process.env["FRONTEND_E2E_PASSKEY_DIRECTORY"] = org
    process.env["BASE_URL"] = url
    await use(url)
  } finally {
    for (const { child } of services.values()) child.kill("SIGTERM")
    const kill = setTimeout(() => {
      for (const { child } of services.values()) child.kill("SIGKILL")
    }, 3000)
    try {
      await Promise.all([...services.values()].map(({ closed }) => closed))
    } finally {
      clearTimeout(kill)
      await rm(org, { recursive: true, force: true })
    }
  }
}
