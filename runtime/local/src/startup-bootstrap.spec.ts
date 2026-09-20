import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { describe, expect, it } from "bun:test"

interface NxTarget {
  readonly cache?: boolean
  readonly dependsOn?: readonly string[]
  readonly continuous?: boolean
  readonly parallelism?: boolean
  readonly options?: {
    readonly command?: string
    readonly env?: Readonly<Record<string, string>>
    readonly cwd?: string
  }
}

interface RuntimeLocalProjectJson {
  readonly targets: Record<string, NxTarget>
}

const loadNxResolvedProject = (): RuntimeLocalProjectJson => {
  const workspaceRoot = join(import.meta.dir, "..", "..", "..")
  const result = spawnSync(
    "bun",
    ["nx", "show", "project", "@processfocus/runtime-local", "--json"],
    {
      cwd: workspaceRoot,
      encoding: "utf8",
      timeout: 30_000,
    },
  )

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout)
  }

  return JSON.parse(result.stdout) as RuntimeLocalProjectJson
}

const projectJson = loadNxResolvedProject()

describe("local runtime startup bootstrap", () => {
  it("requires an uncached worker preflight before starting the dev stack", () => {
    const check = projectJson.targets["job-worker:check"]
    expect(check?.options?.command).toContain("job-worker.ts --check")
    expect(check?.options?.command).not.toContain("--watch")
    expect(check?.cache).toBe(false)
    expect(check?.continuous ?? false).toBe(false)
    expect(check?.dependsOn).toContain(
      "@processfocus/runtime-local:import:bootstrap",
    )
    for (const target of [
      "serve",
      "import:watch",
      "graphql-server:dev:bootstrapped",
      "authentication-server:dev:bootstrapped",
      "job-worker:dev:bootstrapped",
    ]) {
      expect(projectJson.targets[target]?.dependsOn).toContain(
        "@processfocus/runtime-local:job-worker:check",
      )
    }
  })

  it("builds a fresh generic Dashboard before packaging the runtime", () => {
    const build = projectJson.targets["build"]
    const distributionBuild = projectJson.targets["distribution-build"]
    const dashboardBuild = projectJson.targets["dashboard-build"]

    expect(build?.cache).toBe(true)
    expect(build?.dependsOn).not.toContain("dashboard-build")
    expect(distributionBuild?.dependsOn).toContain("build")
    expect(distributionBuild?.dependsOn).toContain("dashboard-build")
    expect(projectJson.targets["pack-check"]?.dependsOn).toContain(
      "distribution-build",
    )
    expect(dashboardBuild?.options?.command).toContain("NODE_ENV=production")
    expect(dashboardBuild?.options?.command).toContain(
      "DASHBOARD_DISTRIBUTION=generic",
    )
    expect(dashboardBuild?.options?.env?.["SQLITE_DATABASE_PATH"]).toBe("")
    expect(dashboardBuild?.parallelism).toBe(false)
  })

  it("starts orchestrated services only after the initial import", () => {
    const targets = projectJson.targets

    expect(targets["serve"]?.dependsOn).toContain(
      "@processfocus/runtime-local:graphql-server:dev:bootstrapped",
    )
    expect(targets["serve"]?.dependsOn).toContain(
      "@processfocus/runtime-local:authentication-server:dev:bootstrapped",
    )
    expect(targets["serve"]?.dependsOn).toContain(
      "@processfocus/runtime-local:job-worker:dev:bootstrapped",
    )
    expect(targets["serve"]?.dependsOn).toContain(
      "@processfocus/runtime-local:import:watch",
    )

    expect(targets["graphql-server:dev:bootstrapped"]?.dependsOn).toContain(
      "@processfocus/runtime-local:import:bootstrap",
    )
    expect(
      targets["authentication-server:dev:bootstrapped"]?.dependsOn,
    ).toContain("@processfocus/runtime-local:import:bootstrap")
    expect(targets["job-worker:dev:bootstrapped"]?.dependsOn).toContain(
      "@processfocus/runtime-local:import:bootstrap",
    )
    expect(targets["import:watch"]?.dependsOn).toContain(
      "@processfocus/runtime-local:import:bootstrap",
    )
  })

  it("runs watched import as a continuous post-bootstrap liveness dependency", () => {
    const importWatch = projectJson.targets["import:watch"]

    expect(importWatch?.continuous).toBe(true)
    expect(importWatch?.options?.command).toContain("import --watch")
    expect(importWatch?.options?.command).toContain("--watch-skip-initial")
  })

  it("serves the frontend via a cross-platform launcher without shell env/bashisms", () => {
    const serve = projectJson.targets["serve"]
    const command = serve?.options?.command ?? ""

    expect(command).toContain("serve-frontend.ts")
    // No POSIX shell env assignment, command substitution, or bash expansion.
    expect(command).not.toMatch(/\w+=\S/)
    expect(command).not.toContain("$(")
    expect(command).not.toContain("${")
    expect(command).not.toContain("FRONTEND_PORT:-")
    expect(command).not.toContain('PORT="${FRONTEND_PORT')
  })

  it("applies NODE_ENV=development via nx env for watch servers", () => {
    const watchTargets = [
      "graphql-server:dev",
      "authentication-server:dev",
      "job-worker:dev",
      "graphql-server:dev:bootstrapped",
      "authentication-server:dev:bootstrapped",
      "job-worker:dev:bootstrapped",
    ] as const

    for (const name of watchTargets) {
      const target = projectJson.targets[name]
      expect(target?.options?.env?.["NODE_ENV"]).toBe("development")
      expect(target?.options?.command).not.toMatch(/^NODE_ENV=/)
      expect(target?.options?.command).not.toContain("NODE_ENV=")
    }
  })

  it("keeps direct service targets usable without bootstrap dependencies", () => {
    expect(projectJson.targets["graphql-server:dev"]?.dependsOn).toBeUndefined()
    expect(
      projectJson.targets["authentication-server:dev"]?.dependsOn,
    ).toBeUndefined()
    expect(projectJson.targets["job-worker:dev"]?.dependsOn).not.toContain(
      "@processfocus/runtime-local:import:bootstrap",
    )
  })
})
