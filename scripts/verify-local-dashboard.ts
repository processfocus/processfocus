import { createHash } from "node:crypto"
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { Schema } from "effect"

// Run after pack-check. This fixture is intentionally outside the workspace.
// Keep it for browser acceptance and diagnosis; print only key fingerprints.
const workspace = resolve(import.meta.dir, "..")
const root = mkdtempSync(join(tmpdir(), "pf-dashboard-consumer-"))
const artifacts = join(root, "tarballs")
mkdirSync(artifacts)
mkdirSync(join(root, "src"))
const dependencies: Record<string, string> = {}
for (const name of [
  "processfocus",
  "@processfocus/runtime",
  "@processfocus/hosting-contract",
  "@processfocus/cli",
  "@processfocus/runtime-local",
  "@processfocus/plugin-posthog",
]) {
  const prefix = name.replace("@", "").replace("/", "-")
  const directory = join(workspace, "dist/packages", prefix)
  const tar = readdirSync(directory).find((file) => file.endsWith(".tgz"))
  if (!tar) throw new Error(`Run pack-check for ${name} first`)
  cpSync(join(directory, tar), join(artifacts, tar))
  dependencies[name] = `./tarballs/${tar}`
}
const args = [
  "--org",
  ".",
  "--auth-port",
  "14020",
  "--graphql-port",
  "14000",
  "--dashboard-port",
  "13000",
]
const manifest = {
  name: "dashboard-consumer",
  private: true,
  type: "module",
  scripts: {
    build: `pf-runtime-local --build ${args.join(" ")}`,
    start: `pf-runtime-local ${args.join(" ")}`,
  },
  dependencies,
  overrides: dependencies,
}
writeFileSync(join(root, "package.json"), JSON.stringify(manifest, null, 2))
writeFileSync(
  join(root, ".gitignore"),
  "node_modules/\ndist/\ndb/\nfiles/\n.*-port.json\n.processfocus/\n",
)
writeFileSync(
  join(root, "src/index.ts"),
  `
import { Organisation, Role, Invitation, Process, Form, AuthenticationConfig } from "processfocus"
import { PostHog } from "@processfocus/plugin-posthog"
import { Schema } from "effect"
export const org = new Organisation({ name: "Consumer Dashboard" })
const role = new Role(org, "Operator", { name: "Operator" })
new AuthenticationConfig(org, "auth", { inviteOnly: true, passkey: { rpName: "Consumer Dashboard", rpID: "localhost", origin: "http://localhost:13000" } })
new Invitation(org, "tester", { email: "consumer@example.com", roles: [role] })
const process = new Process(org, "Request", { name: "Consumer request", purpose: "Verify the installed Dashboard" })
const submit = new Form(process, "Submit", { name: "Submit request", role, form: () => ({ description: Schema.String }) })
const review = new Form(process, "Review", { name: "Review request", role, form: () => ({ approved: Schema.Boolean }) })
process.start(submit).next(review).end()
new PostHog(org, "analytics", { enabled: true, apiKey: "phc_local_fixture", host: "http://localhost:14080" })
`,
)
const env = {
  ...process.env,
  NODE_ENV: "development",
  PF_BYPASS_AUTH: undefined,
  PF_RUNTIME_ROOT: root,
  PF_ORG: root,
  NODE_PATH: undefined,
}
const run = async (command: string[], log: string): Promise<void> => {
  const fd = openSync(join(root, log), "w")
  const child = Bun.spawn(command, {
    cwd: root,
    env,
    stdout: fd,
    stderr: fd,
  })
  const timer = setTimeout(() => child.kill("SIGTERM"), 240_000)
  const code = await child.exited
  clearTimeout(timer)
  closeSync(fd)
  if (code !== 0)
    throw new Error(`${command[0]} failed (${code}); see ${join(root, log)}`)
}
console.log(`Consumer: ${root}`)
await run([process.execPath, "install"], "install.log")
await run(
  [
    process.execPath,
    "-e",
    'try { import.meta.resolve("nx"); process.exit(1) } catch {}',
  ],
  "no-nx.log",
)
const installed = join(root, "node_modules/@processfocus/runtime-local")
if (!realpathSync(installed).startsWith(`${root}/`))
  throw new Error("Runtime escaped isolated installation")
const fingerprint = (directory: string): string => {
  const hash = createHash("sha256")
  const walk = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      if (entry.name === "node_modules") continue
      const file = join(path, entry.name)
      if (entry.isDirectory()) walk(file)
      else hash.update(file.slice(directory.length)).update(readFileSync(file))
    }
  }
  walk(directory)
  return hash.digest("hex")
}
const installedHash = fingerprint(installed)
const cli = join(root, "node_modules/.bin/pf-runtime-local")
const assertServicesStopped = (): void => {
  for (const port of [13000, 14000, 14020]) {
    const listener = Bun.listen({
      hostname: "127.0.0.1",
      port,
      socket: { data() {} },
    })
    listener.stop(true)
  }
}
const build = async (log: string): Promise<void> => {
  await run([process.execPath, cli, "--build", ...args], log)
  assertServicesStopped()
}
const app = join(root, ".processfocus/dashboard/apps/frontend")
const keyFingerprints = (): string[] => {
  const actions = Schema.decodeUnknownSync(
    Schema.Struct({ encryptionKey: Schema.String }),
  )(
    JSON.parse(
      readFileSync(
        join(app, ".next/server/server-reference-manifest.json"),
        "utf8",
      ),
    ),
  )
  const preview = Schema.decodeUnknownSync(
    Schema.Struct({
      preview: Schema.Struct({
        previewModeId: Schema.String,
        previewModeEncryptionKey: Schema.String,
        previewModeSigningKey: Schema.String,
      }),
    }),
  )(
    JSON.parse(
      readFileSync(join(app, ".next/prerender-manifest.json"), "utf8"),
    ),
  )
  return [actions.encryptionKey, ...Object.values(preview.preview)].map((key) =>
    createHash("sha256").update(key).digest("hex"),
  )
}
const checkStart = async (): Promise<void> => {
  const fd = openSync(join(root, "start.log"), "w")
  const child = Bun.spawn([process.execPath, cli, ...args], {
    cwd: root,
    env,
    stdout: fd,
    stderr: fd,
  })
  try {
    for (let attempt = 0; attempt < 300; attempt++) {
      if (child.exitCode !== null)
        throw new Error(`Start failed; see ${root}/start.log`)
      try {
        const response = await fetch("http://127.0.0.1:13000/login", {
          signal: AbortSignal.timeout(1000),
        })
        if (
          response.ok &&
          (await response.text()).includes("Consumer Dashboard")
        )
          return
      } catch {
        /* Wait for bootstrap/readiness. */
      }
      await Bun.sleep(100)
    }
    throw new Error("Dashboard login did not become ready")
  } finally {
    child.kill("SIGTERM")
    await child.exited
    closeSync(fd)
    assertServicesStopped()
  }
}
await build("build-first.log")
const first = keyFingerprints()
await checkStart()
if (JSON.stringify(keyFingerprints()) !== JSON.stringify(first))
  throw new Error("Restart changed build keys")
await checkStart()
if (JSON.stringify(keyFingerprints()) !== JSON.stringify(first))
  throw new Error("Second restart changed build keys")
const checkIncompatible = async (log: string): Promise<void> => {
  const fd = openSync(join(root, log), "w")
  try {
    const child = Bun.spawn([process.execPath, cli, ...args], {
      cwd: root,
      env,
      stdout: fd,
      stderr: fd,
    })
    if (
      (await child.exited) === 0 ||
      !readFileSync(join(root, log), "utf8").includes("missing or incompatible")
    )
      throw new Error(
        `Changed inputs did not require rebuild; see ${root}/${log}`,
      )
  } finally {
    closeSync(fd)
    assertServicesStopped()
  }
}
const orgSource = join(root, "src/index.ts")
const originalOrg = readFileSync(orgSource, "utf8")
writeFileSync(
  orgSource,
  originalOrg.replace("phc_local_fixture", "phc_updated_fixture"),
)
await checkIncompatible("organisation-update.log")
writeFileSync(orgSource, originalOrg)
await checkStart()
// Exercise a dependency update using a packed, installed dependency range.
await run(
  [process.execPath, "add", "@types/validator@13.15.10"],
  "dependency-update.log",
)
await checkIncompatible("incompatible.log")
await build("build-second.log")
const second = keyFingerprints()
if (first.some((key, index) => key === second[index]))
  throw new Error("Fresh builds reused generated keys")
await checkStart()
if (fingerprint(installed) !== installedHash)
  throw new Error("Build mutated installed runtime contents")
if (!existsSync(join(root, ".processfocus/.gitignore")))
  throw new Error("Generated build is not ignored")
const composition = Schema.decodeUnknownSync(
  Schema.Struct({
    active: Schema.Array(Schema.Struct({ type: Schema.String })),
  }),
)(
  JSON.parse(
    readFileSync(
      join(app, "lib/generated/organisation-plugin-composition.json"),
      "utf8",
    ),
  ),
)
if (!composition.active.some((plugin) => plugin.type === "analytics.posthog"))
  throw new Error("Missing organisation browser plugin")
writeFileSync(
  join(root, "verification.json"),
  JSON.stringify(
    {
      root,
      noNx: true,
      independentKeys: true,
      restartReusesKeys: true,
      dependencyUpdateRebuild: true,
      organisationUpdateRequiresRebuild: true,
      installedPackageUnmodified: true,
      plugin: "analytics.posthog",
      first,
      second,
    },
    null,
    2,
  ),
)
console.log(
  `Verified install/build/start/restart/rebuild. Browser fixture retained: ${root}`,
)
console.log(`Run: cd ${root} && bun run start`)
