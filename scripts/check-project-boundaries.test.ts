import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ProjectGraph } from "@nx/devkit"
import {
  validateComposedDashboardBuildInputs,
  validateConsolePluginBuildIsolation,
  validateConsolePluginDependencyGraph,
  validateDashboardDependencyFiles,
  validateDashboardDependencyGraph,
} from "../tools/project-boundaries/dashboard-dependency-boundary"
import {
  PRIVATE_SOURCE_PROJECT_ROOTS,
  PUBLIC_SNAPSHOT_INPUTS,
  PUBLIC_SOURCE_PROJECT_ROOTS,
  VERIFIED_BUNDLED_DEPENDENCIES,
} from "../tools/project-boundaries/policy"
import {
  isRuntimeHostDependencyFile,
  validateExecutorDescriptorOwnership,
  validateNonGraphReferenceFiles,
  validateOrganisationPluginModel,
  validatePathDependency,
  validateProjectGraph,
  validatePublicationAllowlistUniqueness,
  validatePublicationStatus,
  validateReleaseDependencies,
  validateRuntimeHostDependencyFiles,
} from "./check-project-boundaries"

test("rejects catalog composition and retired host APIs", () => {
  for (const content of [
    "PF_TRUSTED_FRONTEND_PLUGIN_CATALOG",
    "trusted-main-realm",
    "TrustedFrontendPlugin",
    "trustedFrontendPlugin",
  ]) {
    expect(
      validateOrganisationPluginModel([
        { path: "apps/frontend/lib/plugin.ts", content },
      ]),
    ).toHaveLength(1)
  }
  expect(
    validateOrganisationPluginModel([
      {
        path: "runtime/aws/trusted-frontend-plugin-catalog.json",
        content: "{}",
      },
    ]),
  ).toHaveLength(1)
  expect(
    validateOrganisationPluginModel([
      {
        path: "apps/frontend/lib/plugin.ts",
        content: "OrganisationFrontendPluginHost",
      },
    ]),
  ).toEqual([])
})

test("rejects future official and private runtime implementation dependencies", () => {
  for (const root of ["runtime/local", "runtime/aws"]) {
    for (const packageName of [
      "@processfocus/plugin-new",
      "@processfocus/plugin-posthog",
      "@pf/cloud-org",
    ]) {
      expect(
        validateRuntimeHostDependencyFiles([
          {
            path: `${root}/package.json`,
            content: JSON.stringify({
              dependencies: { [packageName]: "workspace:*" },
            }),
          },
        ]),
      ).toHaveLength(1)
    }
  }
})

import {
  capturePublicWorktree,
  createPublicSourceSnapshot,
} from "./create-public-source-snapshot"
import { afterAll, describe, expect, test } from "bun:test"

const node = (name: string, root: string, tags: string[]) => ({
  name,
  type: "lib" as const,
  data: { root, tags },
})

const graph = ({
  sourceTags,
  targetTags,
  type = "static",
}: {
  sourceTags: string[]
  targetTags: string[]
  type?: "static" | "dynamic" | "implicit"
}): ProjectGraph => ({
  nodes: {
    source: node("source", "packages/source", sourceTags),
    target: node("target", "packages/target", targetTags),
  },
  externalNodes: {},
  dependencies: {
    source: [{ source: "source", target: "target", type }],
    target: [],
  },
})

describe("project boundary policy", () => {
  test("keeps cloud-org executor identity and policy out of generic hosts", () => {
    expect(
      validateExecutorDescriptorOwnership([
        {
          path: "runtime/aws/src/services/executor-host.ts",
          content:
            'const executor = "deploy-project"\nconst action = "cloudformation:DeleteStack"',
        },
        {
          path: "cloud/org/src/executor-descriptors.ts",
          content:
            'const executor = "deploy-project"\nconst action = "cloudformation:DeleteStack"',
        },
      ]),
    ).toEqual([
      'runtime/aws/src/services/executor-host.ts contains cloud-org executor implementation token "deploy-project". Keep descriptor identity, target policy, and executor-specific configuration in cloud/org/src/executor-descriptors.ts.',
      "runtime/aws/src/services/executor-host.ts contains cloud-org executor implementation token cloudformation:DeleteStack. Keep descriptor identity, target policy, and executor-specific configuration in cloud/org/src/executor-descriptors.ts.",
    ])
  })

  test("scans generic AWS utility adapters for cloud-org executor details", () => {
    expect(
      validateExecutorDescriptorOwnership([
        {
          path: "runtime/aws/src/utils/bundle-organisation.ts",
          content: 'const executor = "deploy-project"',
        },
      ]),
    ).toEqual([
      'runtime/aws/src/utils/bundle-organisation.ts contains cloud-org executor implementation token "deploy-project". Keep descriptor identity, target policy, and executor-specific configuration in cloud/org/src/executor-descriptors.ts.',
    ])
  })

  test.each([
    "parameter/pf-{{projectNumber}}/env/{{environmentName}}",
    "parameter/pf-{{projectNumber}}/stage/{{stageName}}",
    "parameter/turso/*",
    "parameter/otel/*",
    "parameter/route53/app/*",
    "parameter/cdk-bootstrap/hnb659fds/version",
    "function:pf-{{projectNumber}}-{{environmentName}}",
  ])(
    "keeps cloud-org executor policy resource %s out of generic hosts",
    (token) => {
      expect(
        validateExecutorDescriptorOwnership([
          {
            path: "runtime/aws/src/services/executor-host.ts",
            content: `const resource = ${JSON.stringify(token)}`,
          },
        ]).join("\n"),
      ).toContain(`contains cloud-org executor implementation token ${token}`)
    },
  )

  test("rejects concrete Docker plugin dependencies from runtime hosts", () => {
    expect(
      validateRuntimeHostDependencyFiles([
        {
          path: "runtime/local/src/executor.ts",
          content:
            'import { DockerStepRuntime } from "@processfocus/plugin-docker/runtime"',
        },
        {
          path: "runtime/aws/tsconfig.app.json",
          content:
            '{"references":[{"path":"../../plugins/docker/tsconfig.lib.json"}]}',
        },
      ]),
    ).toEqual([
      "runtime/local has a concrete Docker plugin dependency in runtime/local/src/executor.ts. Depend on @processfocus/runtime executor and file-resolution host contracts instead.",
      "runtime/aws has a concrete Docker plugin dependency in runtime/aws/tsconfig.app.json. Depend on @processfocus/runtime executor and file-resolution host contracts instead.",
    ])
  })

  test.each([
    [
      "AWS Lambda",
      "runtime/aws/package.json",
      "@processfocus/plugin-aws-lambda",
      "plugins/aws",
    ],
    [
      "Xero",
      "runtime/local/src/job-worker/job-worker.ts",
      "@processfocus/plugin-xero/runtime",
      "plugins/xero",
    ],
  ])(
    "rejects concrete %s plugin dependencies from runtime hosts",
    (displayName, path, packageName, projectRoot) => {
      expect(
        validateRuntimeHostDependencyFiles([
          {
            path,
            content: path.endsWith("package.json")
              ? JSON.stringify({
                  dependencies: { [packageName]: "workspace:*" },
                })
              : `import "${packageName}"`,
          },
          {
            path: "runtime/aws/tsconfig.app.json",
            content: JSON.stringify({
              references: [{ path: `../../${projectRoot}` }],
            }),
          },
        ]),
      ).toEqual([
        `${path.startsWith("runtime/aws") ? "runtime/aws" : "runtime/local"} has a concrete ${displayName} plugin dependency in ${path}. Load the implementation from the organisation artifact instead.`,
        `runtime/aws has a concrete ${displayName} plugin dependency in runtime/aws/tsconfig.app.json. Load the implementation from the organisation artifact instead.`,
      ])
    },
  )

  test("scans runtime host tests for concrete Docker plugin dependencies", () => {
    const testPath = "runtime/aws/test/docker-step-runtime.test.ts"

    expect(isRuntimeHostDependencyFile(testPath)).toBe(true)
    expect(
      validateRuntimeHostDependencyFiles([
        {
          path: testPath,
          content:
            'import { DockerStepRuntime } from "@processfocus/plugin-docker/runtime"',
        },
      ]),
    ).toEqual([
      "runtime/aws has a concrete Docker plugin dependency in runtime/aws/test/docker-step-runtime.test.ts. Depend on @processfocus/runtime executor and file-resolution host contracts instead.",
    ])
  })

  test("rejects project-level Docker plugin dependencies from runtime hosts", () => {
    expect(
      validateRuntimeHostDependencyFiles([
        {
          path: "runtime/local/project.json",
          content: JSON.stringify({
            implicitDependencies: ["@processfocus/plugin-docker"],
          }),
        },
      ]),
    ).toEqual([
      "runtime/local has a concrete Docker plugin dependency in runtime/local/project.json. Depend on @processfocus/runtime executor and file-resolution host contracts instead.",
    ])
  })

  test("allows Docker plugin release verification from the AWS runtime project", () => {
    expect(
      validateRuntimeHostDependencyFiles([
        {
          path: "runtime/aws/project.json",
          content: JSON.stringify({
            targets: {
              "private-consumer": {
                dependsOn: [
                  {
                    projects: ["@processfocus/plugin-docker"],
                    target: "pack-check",
                  },
                ],
              },
            },
          }),
        },
      ]),
    ).toEqual([])
  })

  test("rejects concrete Google Drive dependencies from runtime hosts", () => {
    expect(
      validateRuntimeHostDependencyFiles([
        {
          path: "runtime/local/package.json",
          content: JSON.stringify({
            dependencies: {
              "@processfocus/plugin-google-drive": "workspace:*",
            },
          }),
        },
        {
          path: "runtime/aws/src/lambdas/graphql-server.ts",
          content: 'import "@processfocus/plugin-google-drive/register-walker"',
        },
      ]),
    ).toEqual([
      "runtime/local has a concrete Google Drive plugin dependency in runtime/local/package.json. Load its walker and browser implementation from the organisation artifact instead.",
      "runtime/aws has a concrete Google Drive plugin dependency in runtime/aws/src/lambdas/graphql-server.ts. Load its walker and browser implementation from the organisation artifact instead.",
    ])
  })

  test("allows Google Drive packed-consumer verification from the AWS runtime project", () => {
    expect(
      validateRuntimeHostDependencyFiles([
        {
          path: "runtime/aws/project.json",
          content: JSON.stringify({
            targets: {
              "private-consumer": {
                dependsOn: [
                  {
                    projects: ["@processfocus/plugin-google-drive"],
                    target: "pack-check",
                  },
                ],
              },
            },
          }),
        },
      ]),
    ).toEqual([])
  })

  test.each(["@processfocus/plugin-aws-lambda", "@processfocus/plugin-xero"])(
    "allows %s release verification from the AWS runtime project",
    (packageName) => {
      expect(
        validateRuntimeHostDependencyFiles([
          {
            path: "runtime/aws/project.json",
            content: JSON.stringify({
              targets: {
                "private-consumer": {
                  dependsOn: [
                    {
                      projects: [packageName],
                      target: "pack-check",
                    },
                  ],
                },
              },
            }),
          },
        ]),
      ).toEqual([])
    },
  )

  test("rejects non-pack-check Docker plugin dependencies from private-consumer", () => {
    expect(
      validateRuntimeHostDependencyFiles([
        {
          path: "runtime/aws/project.json",
          content: JSON.stringify({
            targets: {
              "private-consumer": {
                dependsOn: [
                  {
                    projects: ["@processfocus/plugin-docker"],
                    target: "build",
                  },
                ],
              },
            },
          }),
        },
      ]),
    ).toEqual([
      "runtime/aws has a concrete Docker plugin dependency in runtime/aws/project.json. Depend on @processfocus/runtime executor and file-resolution host contracts instead.",
    ])
  })

  test("accepts provider-neutral runtime host contracts", () => {
    expect(
      validateRuntimeHostDependencyFiles([
        {
          path: "runtime/local/src/executor.ts",
          content: 'import { ExecutorHost } from "@processfocus/runtime"',
        },
      ]),
    ).toEqual([])
  })

  test("rejects concrete Resend plugin dependencies from runtime hosts", () => {
    expect(
      validateRuntimeHostDependencyFiles([
        {
          path: "runtime/aws/src/graphql-server.ts",
          content:
            'import { ResendWebhook } from "@processfocus/plugin-resend/runtime"',
        },
        {
          path: "runtime/local/package.json",
          content: JSON.stringify({
            dependencies: { "@processfocus/plugin-resend": "workspace:*" },
          }),
        },
      ]),
    ).toEqual([
      "runtime/aws has a concrete Resend plugin dependency in runtime/aws/src/graphql-server.ts. Depend on @processfocus/runtime server-plugin and webhook callback contracts instead.",
      "runtime/local has a concrete Resend plugin dependency in runtime/local/package.json. Depend on @processfocus/runtime server-plugin and webhook callback contracts instead.",
    ])
  })

  test("allows Resend release verification from the AWS runtime project", () => {
    expect(
      validateRuntimeHostDependencyFiles([
        {
          path: "runtime/aws/project.json",
          content: JSON.stringify({
            targets: {
              "private-consumer": {
                dependsOn: [
                  {
                    projects: ["@processfocus/plugin-resend"],
                    target: "pack-check",
                  },
                ],
              },
            },
          }),
        },
      ]),
    ).toEqual([])
  })

  test("rejects every represented public-to-private edge kind", () => {
    for (const type of ["static", "dynamic", "implicit"] as const) {
      const errors = validateProjectGraph(
        graph({
          sourceTags: [
            "visibility:public-source",
            "distribution:workspace-internal",
          ],
          targetTags: [
            "visibility:private-source",
            "distribution:workspace-internal",
          ],
          type,
        }),
      )

      expect(errors.join("\n")).toContain(
        `source -> target (${type}) violates visibility:public-source`,
      )
    }
  })

  test("rejects an unclassified project", () => {
    const errors = validateProjectGraph(
      graph({
        sourceTags: [],
        targetTags: [
          "visibility:public-source",
          "distribution:workspace-internal",
        ],
      }),
    )

    expect(errors.join("\n")).toContain(
      "source (packages/source) must have exactly one visibility tag",
    )
  })

  test("rejects a forbidden path dependency", () => {
    const error = validatePathDependency({
      source: node("public-app", "apps/public", [
        "visibility:public-source",
        "distribution:workspace-internal",
      ]),
      target: node("private-runtime", "runtime/private", [
        "visibility:private-source",
        "distribution:workspace-internal",
      ]),
      kind: "docker-context",
      sourcePath: "apps/public/Dockerfile",
    })

    expect(error).toContain(
      "public-app -> private-runtime (docker-context at apps/public/Dockerfile)",
    )
  })

  test("rejects duplicate publication allowlist entries", () => {
    expect(
      validatePublicationAllowlistUniqueness([
        "processfocus",
        "@processfocus/runtime",
        "processfocus",
      ]).join("\n"),
    ).toContain("must not contain duplicate packages")
  })

  test("accepts a unique publication allowlist of any length", () => {
    expect(validatePublicationAllowlistUniqueness(["processfocus"])).toEqual([])
    expect(
      validatePublicationAllowlistUniqueness([
        "processfocus",
        "@processfocus/runtime",
        "@processfocus/plugin-xero",
      ]),
    ).toEqual([])
  })

  test("rejects an accidentally publishable internal project", () => {
    const error = validatePublicationStatus({
      projectName: "internal-app",
      root: "apps/internal",
      distributionTags: ["distribution:workspace-internal"],
      packagePrivate: false,
    })

    expect(error).toContain(
      "internal-app (apps/internal) is workspace-internal",
    )
  })

  test("rejects an unapproved name on a publishable project", () => {
    const error = validatePublicationStatus({
      projectName: "@pf/process",
      root: "packages/process",
      distributionTags: ["distribution:publishable"],
      packagePrivate: false,
      packageName: "@scope/not-approved",
      plannedPackageName: "processfocus",
    })

    expect(error).toContain(
      "only approved publication identity is processfocus",
    )
  })

  test("rejects internal dependencies when publication is enabled", () => {
    const releaseGraph = graph({
      sourceTags: ["visibility:public-source", "distribution:publishable"],
      targetTags: [
        "visibility:public-source",
        "distribution:workspace-internal",
      ],
    })

    expect(
      validateReleaseDependencies({
        graph: releaseGraph,
        sourceName: "source",
        packagePrivate: false,
      }).join("\n"),
    ).toContain(
      "cannot be published while it depends on workspace-internal project target",
    )
  })

  test("accepts internal dependencies verified as bundled", () => {
    const releaseGraph = graph({
      sourceTags: ["visibility:public-source", "distribution:publishable"],
      targetTags: [
        "visibility:public-source",
        "distribution:workspace-internal",
      ],
    })

    expect(
      validateReleaseDependencies({
        graph: releaseGraph,
        sourceName: "source",
        packagePrivate: false,
        bundledDependencies: ["target"],
      }),
    ).toEqual([])
  })

  test.each([
    "@pf/auth-local-cedar",
    "@pf/auth-session",
    "@pf/openauth",
    "@pf/unverified-implementation",
  ])("checks the CLI's verified auth dependencies: %s", (target) => {
    const source = "@processfocus/cli"
    const errors = validateReleaseDependencies({
      graph: {
        nodes: {
          [source]: node(source, "cli/pfcli", ["distribution:publishable"]),
          [target]: node(target, `packages/${target.slice(4)}`, [
            "distribution:workspace-internal",
          ]),
        },
        dependencies: { [source]: [{ source, target, type: "static" }] },
      },
      sourceName: source,
      packagePrivate: false,
      bundledDependencies: VERIFIED_BUNDLED_DEPENDENCIES[source],
    })

    if (target === "@pf/unverified-implementation") {
      expect(errors).toHaveLength(1)
      expect(errors[0]).toContain(target)
    } else {
      expect(errors).toEqual([])
    }
  })

  test("rejects unreported non-graph references", () => {
    const errors = validateNonGraphReferenceFiles({
      graph: graph({
        sourceTags: [
          "visibility:public-source",
          "distribution:workspace-internal",
        ],
        targetTags: [
          "visibility:private-source",
          "distribution:workspace-internal",
        ],
      }),
      files: [
        {
          path: "packages/source/project.json",
          content: '{"command":"bun packages/target/private.ts"}',
        },
      ],
    })

    expect(errors.join("\n")).toContain(
      "source -> target (non-graph reference in packages/source/project.json",
    )
  })

  test("rejects private project roots in public package scripts", () => {
    const errors = validateNonGraphReferenceFiles({
      graph: graph({
        sourceTags: [
          "visibility:public-source",
          "distribution:workspace-internal",
        ],
        targetTags: [
          "visibility:private-source",
          "distribution:workspace-internal",
        ],
      }),
      files: [
        {
          path: "packages/source/package.json",
          content: '{"scripts":{"build":"bun packages/target/build.ts"}}',
        },
      ],
    })

    expect(errors.join("\n")).toContain(
      "source -> target (non-graph reference in packages/source/package.json",
    )
  })

  test("snapshot inputs include every public root and no private project", () => {
    expect(
      PUBLIC_SOURCE_PROJECT_ROOTS.filter(
        (root) => !PUBLIC_SNAPSHOT_INPUTS.includes(root),
      ),
    ).toEqual([])
    expect(
      PRIVATE_SOURCE_PROJECT_ROOTS.filter((privateRoot) =>
        PUBLIC_SNAPSHOT_INPUTS.some(
          (input) =>
            privateRoot === input || privateRoot.startsWith(`${input}/`),
        ),
      ),
    ).toEqual([])
  })

  test("public snapshots contain only demo and on-boarding examples", async () => {
    const root = await mkdtemp(join(tmpdir(), "pf-public-snapshot-"))
    const destination = join(root, "snapshot")
    try {
      const receipt = createPublicSourceSnapshot(destination, {
        sourceTree: capturePublicWorktree(),
      })
      const examples = [
        ...new Set(
          receipt.files
            .filter(({ path }) => path.startsWith("examples/"))
            .map(({ path }) => path.split("/")[1]),
        ),
      ].sort()
      expect(examples).toEqual(["demo", "on-boarding"])
      expect(
        receipt.files
          .map((file) => file.path)
          .filter((path) => path.startsWith(".github/workflows/")),
      ).toEqual([
        ".github/workflows/public-release.yml",
        ".github/workflows/public-source.yml",
      ])
      expect(PRIVATE_SOURCE_PROJECT_ROOTS).toContain("examples/school")
      expect(PRIVATE_SOURCE_PROJECT_ROOTS).toContain("examples/tbsnz")
      expect(receipt.files.map((file) => file.path)).not.toContain(
        "packages/auth-local-cedar/test/delegation.spec.ts",
      )
      expect(receipt.files.map((file) => file.path)).not.toContain(
        "packages/sqlite-operations/test/delegation-management.test.ts",
      )
      const manifest = await Bun.file(join(destination, "package.json")).json()
      expect(manifest.workspaces).toContain("examples/demo")
      expect(manifest.workspaces).not.toContain("examples/school")
      expect(manifest.scripts.prepare).toBeUndefined()
      const sqliteOperations = await Bun.file(
        join(destination, "packages/sqlite-operations/package.json"),
      ).json()
      expect(
        sqliteOperations.devDependencies["@pf/layer-sqlite-bun"],
      ).toBeUndefined()
      const sqliteReferences = await Bun.file(
        join(destination, "packages/sqlite-operations/tsconfig.lib.json"),
      ).json()
      expect(sqliteReferences.references).not.toContainEqual({
        path: "../layer-sqlite-bun/tsconfig.lib.json",
      })
      expect(sqliteReferences.references).toContainEqual({
        path: "../service-drizzle-sqlite/tsconfig.lib.json",
      })
      const lock = await Bun.file(join(destination, "bun.lock")).json()
      expect(Object.keys(lock.workspaces).sort()).toEqual(
        ["", ...manifest.workspaces].sort(),
      )
      const references = await Bun.file(
        join(destination, "tsconfig.json"),
      ).json()
      expect(references.references).toContainEqual({
        path: "./fixtures/external-authoring",
      })
      for (const { path } of references.references)
        expect(
          await Bun.file(join(destination, path, "tsconfig.json")).exists(),
        ).toBe(true)
      const runtime = await Bun.file(
        join(destination, "runtime/local/project.json"),
      ).json()
      expect(runtime.targets["dashboard-build"].options.command).toBe(
        "NODE_ENV=production DASHBOARD_DISTRIBUTION=generic bash scripts/build-public-dashboard.sh",
      )
      expect(
        await Bun.file(
          join(destination, "apps/graphql-e2e/steps/index.ts"),
        ).text(),
      ).not.toContain("cloud-org.steps")
      for (const path of [
        "scripts/build-public-dashboard.sh",
        "scripts/ci-frontend-build-lifecycle.sh",
        "scripts/ci-frontend-build-database.sh",
        "public-source.json",
      ])
        expect(receipt.files.some((file) => file.path === path)).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)

  test("rejects private Docker Compose contexts", () => {
    const errors = validateNonGraphReferenceFiles({
      graph: graph({
        sourceTags: [
          "visibility:public-source",
          "distribution:workspace-internal",
        ],
        targetTags: [
          "visibility:private-source",
          "distribution:workspace-internal",
        ],
      }),
      files: [
        {
          path: "packages/source/docker-compose.yml",
          content:
            "services:\n  private:\n    build:\n      context: ../../packages/target\n",
        },
      ],
    })

    expect(errors.join("\n")).toContain("packages/source/docker-compose.yml")
  })

  test("rejects exact private roots assigned to dynamic paths", () => {
    const errors = validateNonGraphReferenceFiles({
      graph: graph({
        sourceTags: [
          "visibility:public-source",
          "distribution:workspace-internal",
        ],
        targetTags: [
          "visibility:private-source",
          "distribution:workspace-internal",
        ],
      }),
      files: [
        {
          path: "packages/source/src/loader.ts",
          content:
            'const modulePath = "../../../packages/target"\nimport(modulePath)',
        },
      ],
    })

    expect(errors.join("\n")).toContain("packages/source/src/loader.ts")
  })

  test("ignores inert private package labels", () => {
    const errors = validateNonGraphReferenceFiles({
      graph: graph({
        sourceTags: [
          "visibility:public-source",
          "distribution:workspace-internal",
        ],
        targetTags: [
          "visibility:private-source",
          "distribution:workspace-internal",
        ],
      }),
      files: [
        {
          path: "packages/source/src/labels.ts",
          content: 'export const label = "target"',
        },
      ],
    })

    expect(errors).toEqual([])
  })
})

describe("generic Dashboard dependency boundary", () => {
  const dashboardGraph = (): ProjectGraph => ({
    nodes: {
      "@pf/frontend": node("@pf/frontend", "apps/frontend", [
        "visibility:public-source",
        "distribution:workspace-internal",
      ]),
      "@pf/plugins-example": node("@pf/plugins-example", "plugins/example", [
        "visibility:public-source",
        "distribution:workspace-internal",
      ]),
      "@pf/cloud-org": node("@pf/cloud-org", "cloud/org", [
        "visibility:private-source",
        "distribution:workspace-internal",
      ]),
    },
    externalNodes: {},
    dependencies: {
      "@pf/frontend": [],
      "@pf/plugins-example": [],
      "@pf/cloud-org": [],
    },
  })

  test.each([
    ["static source import", "lib/plugin.ts", 'import "@pf/plugins-example"'],
    [
      "dynamic source import",
      "lib/plugin.ts",
      'void import("@pf/plugins-example/client")',
    ],
    [
      "template-literal dynamic source import",
      "lib/plugin.ts",
      "void import(`@pf/plugins-example/client`)",
    ],
    [
      "const-bound dynamic source import",
      "lib/plugin.ts",
      'const pluginModule = "@pf/plugins-example/client"\nvoid import(pluginModule)',
    ],
    [
      "typed const-bound dynamic source import",
      "lib/plugin.ts",
      'const pluginModule: string = "@pf/plugins-example/client"\nvoid import(pluginModule)',
    ],
    [
      "mutable-bound dynamic source import",
      "lib/plugin.ts",
      'let pluginModule = "@pf/plugins-example/client"\nvoid import(pluginModule)',
    ],
    [
      "reassigned dynamic source import",
      "lib/plugin.ts",
      'let pluginModule = "@pf/safe"\npluginModule = "@pf/plugins-example/client"\nvoid import(pluginModule)',
    ],
    [
      "computed CommonJS require",
      "lib/plugin.cjs",
      'const pluginModule = "@pf/plugins-example/client"\nrequire(pluginModule)',
    ],
    [
      "type-only source import",
      "lib/plugin.ts",
      'import type { Plugin } from "@pf/plugins-example/types"',
    ],
    [
      "package dependency",
      "package.json",
      '{"dependencies":{"@pf/plugins-example":"workspace:*"}}',
    ],
    [
      "npm package alias dependency",
      "package.json",
      '{"dependencies":{"plugin":"npm:@pf/plugins-example@1.0.0"}}',
    ],
    [
      "package import alias",
      "package.json",
      '{"imports":{"#plugin":"@pf/plugins-example/register-client"}}',
    ],
    [
      "TypeScript reference",
      "tsconfig.json",
      '{"references":[{"path":"../../plugins/example"}]}',
    ],
    [
      "normalized TypeScript reference",
      "tsconfig.json",
      '{"references":[{"path":"../../plugins/other/../example"}]}',
    ],
    [
      "TypeScript path alias",
      "tsconfig.json",
      '{"compilerOptions":{"paths":{"@pf/plugins-example/*":["../../plugins/example/src/*"]}}}',
    ],
    [
      "TypeScript package alias",
      "tsconfig.json",
      '{"compilerOptions":{"paths":{"#plugin":["@pf/plugins-example/register-client"]}}}',
    ],
    [
      "TypeScript JSONC package alias",
      "tsconfig.json",
      '{"compilerOptions":{"paths":{"#plugin":["@pf/plugins-example/register-client",],},},}',
    ],
    [
      "stylesheet source import",
      "app/global.css",
      '@source "../../../plugins/example/src/**/*.{ts,tsx}";',
    ],
    [
      "stylesheet relative import",
      "app/global.css",
      '@import "../../../plugins/example/styles.css";',
    ],
    [
      "stylesheet package import",
      "app/global.css",
      '@import "@pf/plugins-example/styles.css";',
    ],
    [
      "stylesheet unquoted URL import",
      "app/global.css",
      "@import url(../../../plugins/example/styles.css);",
    ],
    [
      "normalized stylesheet source import",
      "app/global.css",
      '@source "../../../plugins/other/../example/src/**/*.{ts,tsx}";',
    ],
    [
      "normalized relative source import",
      "lib/plugin.ts",
      'import "../../../plugins/other/../example/src/client"',
    ],
    [
      "duplicate-separator source import",
      "lib/plugin.ts",
      'import "../../../plugins//example/src/client"',
    ],
    [
      "private cloud import",
      "lib/cloud.ts",
      'export { value } from "@pf/cloud-org/client"',
    ],
  ])("rejects %s", (_name, path, content) => {
    const errors = validateDashboardDependencyFiles({
      graph: dashboardGraph(),
      files: [{ path: `apps/frontend/${path}`, content }],
    })

    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain("generic Dashboard boundary")
  })

  test("allows manifest module identities as inert data", () => {
    const errors = validateDashboardDependencyFiles({
      graph: dashboardGraph(),
      files: [
        {
          path: "apps/frontend/lib/frontend-manifest-fixture.ts",
          content:
            'const plugin = { module: "@pf/plugins-example/register-client" }',
        },
      ],
    })

    expect(errors).toEqual([])
  })

  test("parses comment-like text inside JSONC strings", () => {
    const errors = validateDashboardDependencyFiles({
      graph: dashboardGraph(),
      files: [
        {
          path: "apps/frontend/tsconfig.json",
          content:
            '{"description":"/* retained */","compilerOptions":{"paths":{"#plugin":["@pf/plugins-example/register-client"]}}}',
        },
      ],
    })

    expect(errors).toHaveLength(1)
  })

  test("allows inert plugin filesystem paths", () => {
    const errors = validateDashboardDependencyFiles({
      graph: dashboardGraph(),
      files: [
        {
          path: "apps/frontend/lib/frontend-manifest-fixture.ts",
          content: 'const fixture = "plugins/example/src/client"',
        },
      ],
    })

    expect(errors).toEqual([])
  })

  test("allows import examples in trailing comments", () => {
    const errors = validateDashboardDependencyFiles({
      graph: dashboardGraph(),
      files: [
        {
          path: "apps/frontend/lib/example.ts",
          content:
            'const enabled = true // import("@pf/plugins-example/client")',
        },
      ],
    })

    expect(errors).toEqual([])
  })

  test.each([
    [
      "literal dynamic imports with options",
      "apps/frontend/lib/data.ts",
      'void import("./data.json", { with: { type: "json" } })',
    ],
    [
      "closing parentheses in literal dynamic import specifiers",
      "apps/frontend/lib/plugin.ts",
      'void import("./plugin).js")',
    ],
    [
      "dynamic import source emitted by the composition generator",
      "apps/frontend/scripts/generate-organisation-plugin-composition.ts",
      `const generated = \`void import(\${specifier})\``,
    ],
  ])("allows %s", (_name, path, content) => {
    expect(
      validateDashboardDependencyFiles({
        graph: dashboardGraph(),
        files: [{ path, content }],
      }),
    ).toEqual([])
  })

  test("does not parse non-source files as TypeScript", () => {
    expect(
      validateDashboardDependencyFiles({
        graph: dashboardGraph(),
        files: [
          {
            path: "apps/frontend/app/global.css",
            content: ".example { content: 'import(pluginModule)'; }",
          },
        ],
      }),
    ).toEqual([])
  })

  test.each(["static", "dynamic", "implicit"] as const)(
    "rejects an Nx %s plugin dependency",
    (type) => {
      const graph = dashboardGraph()
      graph.dependencies["@pf/frontend"] = [
        {
          source: "@pf/frontend",
          target: "@pf/plugins-example",
          type,
        },
      ]

      expect(validateDashboardDependencyGraph(graph).join("\n")).toContain(
        `@pf/frontend -> @pf/plugins-example (${type})`,
      )
    },
  )

  test.each(["static", "dynamic", "implicit"] as const)(
    "rejects an Nx %s Cloud Org dependency",
    (type) => {
      const graph = dashboardGraph()
      graph.dependencies["@pf/frontend"] = [
        {
          source: "@pf/frontend",
          target: "@pf/cloud-org",
          type,
        },
      ]

      expect(validateDashboardDependencyGraph(graph).join("\n")).toContain(
        `@pf/frontend -> @pf/cloud-org (${type})`,
      )
    },
  )

  test("requires composed OpenNext inputs to use staged artifact bundles", () => {
    expect(
      validateComposedDashboardBuildInputs({
        targets: { "build-opennext": { inputs: [] } },
      }).join("\n"),
    ).toContain("lib/generated/browser-plugins")

    expect(
      validateComposedDashboardBuildInputs({
        targets: {
          "build-opennext": {
            inputs: [
              "{workspaceRoot}/apps/frontend/lib/generated/browser-plugins/**/*",
            ],
          },
        },
      }),
    ).toEqual([])

    expect(
      validateComposedDashboardBuildInputs({
        targets: {
          "build-opennext": {
            inputs: [
              "{workspaceRoot}/apps/frontend/lib/generated/browser-plugins/**/*",
              "{workspaceRoot}/cloud/org/src/register-environment-usage-costs-client.tsx",
            ],
          },
        },
      }).join("\n"),
    ).toContain("not private workspace input")
  })

  test("keeps the customer Console build outside organisation plugin composition", () => {
    const isolatedTargets = {
      "build-console-opennext": {
        inputs: [{ env: "FRONTEND_JWT_TOKEN" }],
      },
      "build-console-for-opennext": {
        dependsOn: [{ projects: ["@pf/cloud-org-console"] }],
      },
    }
    expect(
      validateConsolePluginBuildIsolation({ targets: isolatedTargets }),
    ).toEqual([])
    expect(
      validateConsolePluginBuildIsolation({
        targets: {
          ...isolatedTargets,
          "build-console-opennext": { inputs: [{ env: "PF_ORG" }] },
        },
      }).join("\n"),
    ).toContain("must not reference organisation plugin")
  })

  test("rejects Console dependencies on organisation plugin hosts and implementations", () => {
    const graph = dashboardGraph()
    graph.nodes["@pf/cloud-org-console"] = {
      name: "@pf/cloud-org-console",
      type: "app",
      data: { root: "cloud/org/console" },
    }
    graph.nodes["@pf/frontend-plugin-host"] = {
      name: "@pf/frontend-plugin-host",
      type: "lib",
      data: { root: "packages/frontend-plugin-host" },
    }
    graph.dependencies["@pf/cloud-org-console"] = [
      {
        source: "@pf/cloud-org-console",
        target: "@pf/frontend-plugin-host",
        type: "static",
      },
    ]

    expect(validateConsolePluginDependencyGraph(graph).join("\n")).toContain(
      "violates the Console isolation boundary",
    )
  })
})

const fixtureDirectories: string[] = []

afterAll(async () => {
  await Promise.all(
    fixtureDirectories.map((directory) => rm(directory, { recursive: true })),
  )
})

test("Biome rejects all supported cloud-org import forms in frontend source", async () => {
  const fixtureRoot = await mkdtemp(
    join(process.cwd(), "apps/frontend/.boundary-fixture-"),
  )
  fixtureDirectories.push(fixtureRoot)
  await mkdir(join(fixtureRoot, "nested"))
  const forms = [
    ["static.ts", 'import "@pf/cloud-org"'],
    ["reexport.ts", 'export { value } from "@pf/cloud-org/subpath"'],
    ["type-only.ts", 'import type { CloudType } from "@pf/cloud-org/types"'],
    ["dynamic.ts", 'void import("@pf/cloud-org/dynamic")'],
    ["require.js", 'const cloud = require("@pf/cloud-org")'],
  ] as const

  for (const [name, source] of forms) {
    const fixture = join(fixtureRoot, "nested", name)
    await writeFile(fixture, source)
    const childProcess = Bun.spawn(
      ["bunx", "biome", "lint", "--diagnostic-level=error", fixture],
      { stdout: "pipe", stderr: "pipe" },
    )
    const [exitCode, stdout, stderr] = await Promise.all([
      childProcess.exited,
      new Response(childProcess.stdout).text(),
      new Response(childProcess.stderr).text(),
    ])
    const output = `${stdout}\n${stderr}`

    expect(exitCode, name).not.toBe(0)
    expect(output, name).toContain("lint/style/noRestrictedImports")
  }
}, 15_000)
