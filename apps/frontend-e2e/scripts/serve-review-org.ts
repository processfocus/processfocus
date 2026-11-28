/** One immutable fixture per suite: import once, without Nx or dev watchers. */
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

const org = process.env["PF_ORG"]
if (!org || dirname(org) !== tmpdir())
  throw new Error("A disposable review organisation is required")
const env = {
  ...process.env,
  SQLITE_DATABASE_PATH: join(org, "db/pf.db"),
  NODE_ENV: "development",
  OAUTH_ISSUER_URL: process.env["OAUTH_ISSUER_URL"] ?? "http://localhost:4020",
  FRONTEND_BASE_URL: `http://localhost:${process.env["FRONTEND_PORT"]}`,
  PF_LOCAL_FRONTEND_ORIGIN: `http://localhost:${process.env["FRONTEND_PORT"]}`,
}
const imported = Bun.spawnSync(
  ["bun", "cli/pfcli/src/main.ts", "import", org],
  {
    env,
    stdio: ["ignore", "inherit", "inherit"],
  },
)
if (imported.exitCode !== 0) process.exit(imported.exitCode)

const children = [
  "authentication-server/authentication-server.ts",
  "graphql-server/graphql-server.ts",
  "job-worker/job-worker.ts",
].map((script) =>
  Bun.spawn(["bun", `runtime/local/src/${script}`], {
    env,
    stdout: "inherit",
    stderr: "inherit",
  }),
)
// Playwright's BASE_URL points at the browser origin; the Dashboard itself
// needs the local GraphQL endpoint and issuer when handling a callback.
children.push(
  Bun.spawn(
    [
      "bash",
      "apps/frontend-e2e/scripts/serve-compiled-dashboard.sh",
      "--debug-build-paths",
      [
        "app/api/**",
        "app/register/**",
        "app/login/**",
        "app/(protected)/page.tsx",
        ...[
          "act-on-behalf",
          "executions",
          "passkeys",
          "processes",
          "settings/cedar",
          "to-dos",
        ].map((route) => `app/(protected)/${route}/**`),
      ].join(","),
    ],
    {
      env: {
        ...env,
        BASE_URL: "",
        NODE_ENV: "production",
        GRAPHQL_SERVER_URL: "http://localhost:4000",
      },
      stdout: "inherit",
      stderr: "inherit",
    },
  ),
)
try {
  process.exitCode = await Promise.race(children.map((child) => child.exited))
} finally {
  for (const child of children) child.kill()
}
