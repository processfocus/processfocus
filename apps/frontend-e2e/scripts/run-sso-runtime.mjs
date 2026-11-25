// Invoke inside run-temp-org --import, after building normal Dashboard deps.
import { resolve } from "node:path"

if (!process.env.PF_ORG?.includes("pf-temp-org-"))
  throw new Error("Disposable organisation required")
const env = { ...process.env, NODE_ENV: "development" }
delete env.PF_BYPASS_AUTH
const children = [
  [
    ...(process.env.SSO_ONLY_JOURNEY === "1"
      ? []
      : [
          "--preload",
          resolve("apps/frontend-e2e/scripts/sso-revalidation-preload.ts"),
        ]),
    "--preload",
    resolve("apps/frontend-e2e/scripts/sso-provider-preload.mjs"),
    "runtime/local/src/authentication-server/authentication-server.ts",
  ],
  ["runtime/local/src/graphql-server/graphql-server.ts"],
  ["runtime/local/src/serve-frontend.ts"],
].map((args) =>
  Bun.spawn([process.execPath, ...args], {
    env,
    stdout: "inherit",
    stderr: "inherit",
  }),
)
const stop = () => {
  for (const child of children) child.kill()
}
process.on("SIGTERM", stop)
process.on("SIGINT", stop)
try {
  process.exitCode = await Promise.race(children.map((child) => child.exited))
} finally {
  stop()
}
