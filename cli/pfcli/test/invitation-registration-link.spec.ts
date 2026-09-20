import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DateTime, Effect, Layer, Option } from "effect"
import {
  AuthenticationDatabase,
  exchangePasskeyRecoveryLink,
} from "@pf/auth-api"
import { makeDatabaseConfigLayer } from "@pf/db-info"
import { SettingsQueries } from "@pf/graphql-db-operations"
import { TypedSqliteDrizzleLayer } from "@pf/service-drizzle-sqlite"
import {
  SqliteAuthenticationDatabaseLive,
  SqliteOpenAuthStorageServiceLive,
  SqliteSettingsQueriesLive,
} from "@pf/sqlite-operations"
import {
  resolveLocalRegistrationLinkFrontendOrigin,
  resolveLocalRegistrationLinkOrganisationScope,
} from "../src/commands/invitation-registration-link"
import { makePfcliSqlClientLayer } from "../src/utils/local-database-layer"
import {
  captureStdout,
  copySharedImportedDemoDatabase,
  loadPfcliCommand,
  runPfcliInProcess,
  runWithNodeContext,
  useSerializedTestState,
  withEnv,
} from "./test-helpers"
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test"

const randomSuffix = Math.random().toString(36).substring(2, 8)
const orgRoot = mkdtempSync(
  join(tmpdir(), `test-pfcli-invitation-link-${randomSuffix}-`),
)
let localTestNumber = 0
let localOrgRoot = ""
let localDbPath = ""

useSerializedTestState()

const originalFetch = globalThis.fetch
const originalCredPath = process.env["PFCLI_CREDENTIALS_PATH"]

const createCredentialsFile = (baseUrl: string) => {
  const credentialsPath = join(orgRoot, "credentials.json")
  writeFileSync(
    credentialsPath,
    JSON.stringify(
      {
        version: 1,
        baseUrl,
        accessToken: "test-token",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        loginAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  )

  return credentialsPath
}

type RunInvitationRegistrationLink = (options: {
  orgPath?: string
  projectId?: string
  environmentId?: string
  email?: string
  rotate: boolean
}) => Effect.Effect<unknown>

const localEnv = {
  SQLITE_DATABASE_PATH: undefined,
  PF_SCOPE: undefined,
  PF_ORG: undefined,
  FRONTEND_BASE_URL: undefined,
  BASE_URL: undefined,
  NEXT_PUBLIC_FRONTEND_URL: undefined,
  INVITATION_REGISTRATION_ENCRYPTION_KEY: undefined,
  NODE_ENV: "development",
}

const makeDrizzleLayer = (databasePath: string) => {
  const dbLayer = makePfcliSqlClientLayer(databasePath)
  return TypedSqliteDrizzleLayer.pipe(
    Layer.provideMerge(dbLayer),
    Layer.provide(makeDatabaseConfigLayer(databasePath)),
  )
}

const makeAuthenticationLayer = (databasePath: string) =>
  Layer.merge(
    SqliteAuthenticationDatabaseLive,
    SqliteOpenAuthStorageServiceLive,
  ).pipe(Layer.provide(makeDrizzleLayer(databasePath)))

const makeSettingsLayer = (databasePath: string) =>
  SqliteSettingsQueriesLive.pipe(Layer.provide(makeDrizzleLayer(databasePath)))

const registrationTokenFromOutput = (output: string): string => {
  const match = output.match(/\/register\/passkey#token=([^\s]+)/)
  if (!match?.[1]) {
    throw new Error(
      `Registration Link output did not contain a token: ${JSON.stringify(output)}`,
    )
  }
  return match[1]
}

const loadInvitation = (databasePath: string, email: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const settings = yield* SettingsQueries
      const invitation = yield* settings.queryInvitationByNormalizedEmail(email)
      if (!invitation) {
        throw new Error(`Invitation not found for ${email}`)
      }
      return invitation
    }).pipe(Effect.provide(makeSettingsLayer(databasePath))),
  )

afterEach(() => {
  process.exitCode = 0
  globalThis.fetch = originalFetch
  if (originalCredPath === undefined) {
    delete process.env["PFCLI_CREDENTIALS_PATH"]
  } else {
    process.env["PFCLI_CREDENTIALS_PATH"] = originalCredPath
  }
})

afterAll(() => {
  rmSync(orgRoot, { recursive: true, force: true })
})

describe("pfcli invitation registration-link", () => {
  it("sends remote mutation variables including rotate", async () => {
    const { runInvitationRegistrationLink } = await loadPfcliCommand<{
      runInvitationRegistrationLink: RunInvitationRegistrationLink
    }>("invitation-registration-link")

    process.env["PFCLI_CREDENTIALS_PATH"] =
      createCredentialsFile("http://mocked.test")

    const mutationBodies: Array<Record<string, unknown>> = []

    globalThis.fetch = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const body = JSON.parse(String(init?.body)) as {
        query?: string
        variables?: Record<string, unknown>
      }

      if (body.query?.includes("generateProjectRegistrationLink")) {
        mutationBodies.push(body)
        return new Response(
          JSON.stringify({
            data: {
              generateProjectRegistrationLink: {
                __typename: "ProjectRegistrationLinkSuccess",
                email: "admin@example.com",
                registrationLinkUrl:
                  "https://bdb.0000-1000-1000.app.processfocus.com/register/passkey#token=abc",
                expiresAt: "2026-08-27T12:00:00.000Z",
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )
      }

      return new Response(
        JSON.stringify({
          data: {
            listProjectEnvironments: { items: [{ environmentName: "bdb" }] },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }) as unknown as typeof fetch

    const { output } = await withEnv({}, () =>
      captureStdout(() =>
        runWithNodeContext(
          runInvitationRegistrationLink({
            projectId: "0000-1000-1000",
            environmentId: "bdb",
            email: "  Admin@Example.COM  ",
            rotate: true,
          }),
        ),
      ),
    )

    expect(mutationBodies).toHaveLength(1)
    expect(mutationBodies[0]?.["query"]).toContain(
      "generateProjectRegistrationLink",
    )
    expect(mutationBodies[0]?.["variables"]).toEqual({
      projectId: "0000-1000-1000",
      environmentId: "bdb",
      email: "  Admin@Example.COM  ",
      rotate: true,
    })
    expect(output).toContain(
      "https://bdb.0000-1000-1000.app.processfocus.com/register/passkey#token=abc",
    )
    expect(output).toContain("expires at: 2026-08-27T12:00:00.000Z")
  })

  it("reports missing --email with local and remote examples", async () => {
    const { runInvitationRegistrationLink } = await loadPfcliCommand<{
      runInvitationRegistrationLink: RunInvitationRegistrationLink
    }>("invitation-registration-link")

    let fetchCalled = false
    globalThis.fetch = (async () => {
      fetchCalled = true
      throw new Error("fetch should not be called")
    }) as unknown as typeof fetch

    const { output } = await withEnv({}, () =>
      captureStdout(() =>
        runWithNodeContext(
          runInvitationRegistrationLink({
            rotate: false,
          }),
        ),
      ),
    )

    expect(fetchCalled).toBe(false)
    expect(output).toMatch(/Missing required option: --email/)
    expect(output).toContain("[org-path] --email <invited-email>")
    expect(output).toContain("--project <project-number> --env")
  })

  it("does not print the URL when the mutation fails", async () => {
    const { runInvitationRegistrationLink } = await loadPfcliCommand<{
      runInvitationRegistrationLink: RunInvitationRegistrationLink
    }>("invitation-registration-link")

    process.env["PFCLI_CREDENTIALS_PATH"] =
      createCredentialsFile("http://mocked.test")

    globalThis.fetch = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const body = JSON.parse(String(init?.body)) as { query?: string }

      if (body.query?.includes("generateProjectRegistrationLink")) {
        return new Response(
          JSON.stringify({
            data: {
              generateProjectRegistrationLink: {
                __typename: "ProjectRegistrationLinkFailure",
                error:
                  "An active registration link already exists. Pass --rotate to replace it.",
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )
      }

      return new Response(
        JSON.stringify({
          data: {
            listProjectEnvironments: { items: [{ environmentName: "bdb" }] },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }) as unknown as typeof fetch

    const { output } = await withEnv({}, () =>
      captureStdout(() =>
        runWithNodeContext(
          runInvitationRegistrationLink({
            projectId: "0000-1000-1000",
            environmentId: "bdb",
            email: "admin@example.com",
            rotate: false,
          }),
        ),
      ),
    )

    expect(output).toContain("Pass --rotate to replace it")
    expect(output).not.toContain("#token=")
    expect(output).not.toContain("register/passkey")
  })

  it("fails fast when only one remote selector is provided", async () => {
    const { runInvitationRegistrationLink } = await loadPfcliCommand<{
      runInvitationRegistrationLink: RunInvitationRegistrationLink
    }>("invitation-registration-link")

    let fetchCalled = false
    globalThis.fetch = (async () => {
      fetchCalled = true
      throw new Error("fetch should not be called")
    }) as unknown as typeof fetch

    const { output } = await withEnv({}, () =>
      captureStdout(() =>
        runWithNodeContext(
          runInvitationRegistrationLink({
            projectId: "0000-1000-1000",
            email: "admin@example.com",
            rotate: false,
          }),
        ),
      ),
    )

    expect(fetchCalled).toBe(false)
    expect(output).toContain(
      "Remote mode requires both --project and --env together.",
    )
  })

  it("rejects positional org-path in remote mode", async () => {
    const { runInvitationRegistrationLink } = await loadPfcliCommand<{
      runInvitationRegistrationLink: RunInvitationRegistrationLink
    }>("invitation-registration-link")

    let fetchCalled = false
    globalThis.fetch = (async () => {
      fetchCalled = true
      throw new Error("fetch should not be called")
    }) as unknown as typeof fetch

    const { output } = await withEnv({}, () =>
      captureStdout(() =>
        runWithNodeContext(
          runInvitationRegistrationLink({
            orgPath: orgRoot,
            projectId: "0000-1000-1000",
            environmentId: "bdb",
            email: "admin@example.com",
            rotate: false,
          }),
        ),
      ),
    )

    expect(fetchCalled).toBe(false)
    expect(output).toContain("Remote mode does not accept positional org-path")
  })
})

describe("local Registration Link configuration", () => {
  it("matches runtime scope and trusted frontend origin precedence", async () => {
    await withEnv(
      {
        PF_SCOPE: "configured-scope",
        PF_ORG: "configured-org",
        FRONTEND_BASE_URL: "http://localhost:3100/",
        BASE_URL: "http://localhost:3200",
        NEXT_PUBLIC_FRONTEND_URL: "http://localhost:3300",
      },
      async () => {
        expect(
          resolveLocalRegistrationLinkOrganisationScope("positional-org"),
        ).toBe("configured-scope")
        expect(resolveLocalRegistrationLinkFrontendOrigin()).toBe(
          "http://localhost:3100",
        )
      },
    )

    await withEnv(
      {
        PF_SCOPE: undefined,
        PF_ORG: "configured-org",
        FRONTEND_BASE_URL: undefined,
        BASE_URL: "http://localhost:3200/",
        NEXT_PUBLIC_FRONTEND_URL: "http://localhost:3300",
      },
      async () => {
        expect(
          resolveLocalRegistrationLinkOrganisationScope("positional-org"),
        ).toBe("configured-org")
        expect(resolveLocalRegistrationLinkFrontendOrigin()).toBe(
          "http://localhost:3200",
        )
      },
    )

    await withEnv(
      {
        PF_SCOPE: undefined,
        PF_ORG: undefined,
        FRONTEND_BASE_URL: undefined,
        BASE_URL: undefined,
        NEXT_PUBLIC_FRONTEND_URL: "http://localhost:3300/",
      },
      async () => {
        expect(
          resolveLocalRegistrationLinkOrganisationScope("positional-org"),
        ).toBe("positional-org")
        expect(resolveLocalRegistrationLinkFrontendOrigin()).toBe(
          "http://localhost:3300",
        )
      },
    )

    await withEnv(
      {
        PF_SCOPE: undefined,
        PF_ORG: undefined,
        FRONTEND_BASE_URL: undefined,
        BASE_URL: undefined,
        NEXT_PUBLIC_FRONTEND_URL: undefined,
      },
      async () => {
        expect(resolveLocalRegistrationLinkOrganisationScope()).toBe("local")
        expect(resolveLocalRegistrationLinkFrontendOrigin()).toBe(
          "http://localhost:3000",
        )
      },
    )
  })
})

describe("pfcli invitation registration-link local mode", () => {
  beforeEach(async () => {
    localTestNumber += 1
    localOrgRoot = join(orgRoot, `local-org-${localTestNumber}`)
    localDbPath = join(localOrgRoot, "db", "pf.db")
    await copySharedImportedDemoDatabase(localDbPath)
  })

  it("accepts org-path before --email through the CLI entrypoint", async () => {
    const result = await withEnv(localEnv, () =>
      runPfcliInProcess([
        "invitation",
        "registration-link",
        localOrgRoot,
        "--email",
        "employee@example.com",
      ]),
    )

    expect(result.status).toBe(0)
    expect(result.output).toContain(
      "http://localhost:3000/register/passkey#token=",
    )
  }, 120_000)

  it("accepts --rotate before org-path and --email after it", async () => {
    const initial = await withEnv(localEnv, () =>
      runPfcliInProcess([
        "invitation",
        "registration-link",
        localOrgRoot,
        "--email",
        "employee@example.com",
      ]),
    )
    expect(initial.status).toBe(0)

    const rotated = await withEnv(localEnv, () =>
      runPfcliInProcess([
        "invitation",
        "registration-link",
        "--rotate",
        localOrgRoot,
        "--email",
        "employee@example.com",
      ]),
    )

    expect(rotated.status).toBe(0)
    expect(rotated.output).toContain(
      "http://localhost:3000/register/passkey#token=",
    )
  }, 120_000)

  it("recognises org-path after remote selectors before rejecting mixed mode", async () => {
    const result = await withEnv(localEnv, () =>
      runPfcliInProcess([
        "invitation",
        "registration-link",
        "--project",
        "0000-1000-1000",
        "--env",
        "bdb",
        localOrgRoot,
        "--email",
        "admin@example.com",
      ]),
    )

    expect(result.status).toBe(1)
    expect(result.output).toContain(
      "Remote mode does not accept positional org-path",
    )
  })

  it("reports a missing --email value after org-path", async () => {
    const result = await withEnv(localEnv, () =>
      runPfcliInProcess([
        "invitation",
        "registration-link",
        localOrgRoot,
        "--email",
      ]),
    )

    expect(result.status).toBe(1)
    expect(result.output).toContain("--email requires a value.")
    expect(result.output).not.toContain("Database path not configured")
  })

  it("issues a locally exchangeable link with configured scope, origin, and key", async () => {
    const { runInvitationRegistrationLink } = await loadPfcliCommand<{
      runInvitationRegistrationLink: RunInvitationRegistrationLink
    }>("invitation-registration-link")
    const secret = "local-registration-link-test-secret"
    const organisationScope = "local-test-scope"
    const frontendOrigin = "http://localhost:3456"
    const email = "settings-e2e@example.com"

    const { output } = await withEnv(
      {
        ...localEnv,
        PF_SCOPE: organisationScope,
        FRONTEND_BASE_URL: `${frontendOrigin}/`,
        INVITATION_REGISTRATION_ENCRYPTION_KEY: secret,
      },
      () =>
        captureStdout(() =>
          runWithNodeContext(
            runInvitationRegistrationLink({
              orgPath: localOrgRoot,
              email: `  ${email.toUpperCase()}  `,
              rotate: false,
            }),
          ),
        ),
    )

    expect(output).toContain(`${frontendOrigin}/register/passkey#token=`)
    expect(output).not.toContain(`${frontendOrigin}//register`)
    expect(output).toContain("expires at:")
    const rawToken = registrationTokenFromOutput(output)

    const exchanged = await Effect.runPromise(
      Effect.gen(function* () {
        const authenticationDatabase = yield* AuthenticationDatabase
        return yield* authenticationDatabase.exchangeRegistrationLink(rawToken)
      }).pipe(Effect.provide(makeAuthenticationLayer(localDbPath))),
    )
    expect(Option.isSome(exchanged)).toBe(true)
    if (Option.isSome(exchanged)) {
      expect(exchanged.value.email).toBe(email)
    }

    const invitation = await loadInvitation(localDbPath, email)
    expect(invitation.registrationLinkGeneratedBy).toBe("SYSTEM")
  }, 120_000)

  it("reports an active link and rotates it, invalidating the old token", async () => {
    const { runInvitationRegistrationLink } = await loadPfcliCommand<{
      runInvitationRegistrationLink: RunInvitationRegistrationLink
    }>("invitation-registration-link")
    // Hardcoded demo invitation; passkey@example.com follows RESEND_REROUTE_EMAIL.
    const email = "employee@example.com"

    const runLocal = (rotate: boolean) =>
      withEnv(localEnv, () =>
        captureStdout(() =>
          runWithNodeContext(
            runInvitationRegistrationLink({
              orgPath: localOrgRoot,
              email,
              rotate,
            }),
          ),
        ),
      )

    const first = await runLocal(false)
    const firstToken = registrationTokenFromOutput(first.output)
    const duplicate = await runLocal(false)
    expect(duplicate.output).toContain("Pass --rotate to replace it")
    expect(duplicate.output).not.toContain("#token=")

    const rotated = await runLocal(true)
    const rotatedToken = registrationTokenFromOutput(rotated.output)
    expect(rotatedToken).not.toBe(firstToken)

    const exchangeResults = await Effect.runPromise(
      Effect.gen(function* () {
        const authenticationDatabase = yield* AuthenticationDatabase
        const oldResult =
          yield* authenticationDatabase.exchangeRegistrationLink(firstToken)
        const newResult =
          yield* authenticationDatabase.exchangeRegistrationLink(rotatedToken)
        return { oldResult, newResult }
      }).pipe(Effect.provide(makeAuthenticationLayer(localDbPath))),
    )
    expect(Option.isNone(exchangeResults.oldResult)).toBe(true)
    expect(Option.isSome(exchangeResults.newResult)).toBe(true)
  }, 120_000)

  it("rotate issues a recovery link for an accepted account without reopening the invitation", async () => {
    const email = "employee@example.com"
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* AuthenticationDatabase
        const root = yield* db.findRootOrgUnit()
        if (Option.isNone(root)) throw new Error("Missing root")
        const roleIds = yield* db.findInvitationRoleIds(email)
        const user = yield* db.createProviderUser({
          email,
          name: email,
          firstName: "",
          lastName: "",
          picture: "",
          locale: "",
          provider: "passkey",
          sub: Buffer.from("cli-recovery-handle").toString("base64url"),
          orgUnitId: root.value.id,
        })
        yield* db.assignProviderUserRoles(user.id, roleIds)
        yield* db.acceptPendingInvitationForUser({
          email,
          userId: user.id,
          provider: "passkey",
          subject: user.sub,
          acceptedAt: yield* DateTime.now,
        })
      }).pipe(Effect.provide(makeAuthenticationLayer(localDbPath))),
    )
    const before = await loadInvitation(localDbPath, email)
    const { runInvitationRegistrationLink } = await loadPfcliCommand<{
      runInvitationRegistrationLink: RunInvitationRegistrationLink
    }>("invitation-registration-link")
    const { output } = await withEnv(localEnv, () =>
      captureStdout(() =>
        runWithNodeContext(
          runInvitationRegistrationLink({
            orgPath: localOrgRoot,
            email,
            rotate: true,
          }),
        ),
      ),
    )
    const token = registrationTokenFromOutput(output)
    expect(token.startsWith("pfr_")).toBe(true)
    expect(await loadInvitation(localDbPath, email)).toEqual(before)
    const exchanged = await Effect.runPromise(
      exchangePasskeyRecoveryLink(token).pipe(
        Effect.provide(makeAuthenticationLayer(localDbPath)),
      ),
    )
    expect(Option.isSome(exchanged)).toBe(true)
  }, 120_000)

  it("resolves the local database from PF_ORG when org-path is omitted", async () => {
    const { runInvitationRegistrationLink } = await loadPfcliCommand<{
      runInvitationRegistrationLink: RunInvitationRegistrationLink
    }>("invitation-registration-link")

    const { output } = await withEnv(
      { ...localEnv, PF_ORG: localOrgRoot },
      () =>
        captureStdout(() =>
          runWithNodeContext(
            runInvitationRegistrationLink({
              email: "employee@example.com",
              rotate: false,
            }),
          ),
        ),
    )

    expect(output).toContain("http://localhost:3000/register/passkey#token=")
  }, 120_000)

  it("resolves the local database from SQLITE_DATABASE_PATH when org-path is omitted", async () => {
    const { runInvitationRegistrationLink } = await loadPfcliCommand<{
      runInvitationRegistrationLink: RunInvitationRegistrationLink
    }>("invitation-registration-link")

    const { output } = await withEnv(
      { ...localEnv, SQLITE_DATABASE_PATH: localDbPath },
      () =>
        captureStdout(() =>
          runWithNodeContext(
            runInvitationRegistrationLink({
              email: "employee-2@example.com",
              rotate: false,
            }),
          ),
        ),
    )

    expect(output).toContain("http://localhost:3000/register/passkey#token=")
  }, 120_000)

  it("uses the development encryption key when NODE_ENV is unset", async () => {
    const { runInvitationRegistrationLink } = await loadPfcliCommand<{
      runInvitationRegistrationLink: RunInvitationRegistrationLink
    }>("invitation-registration-link")

    const { output } = await withEnv({ ...localEnv, NODE_ENV: undefined }, () =>
      captureStdout(() =>
        runWithNodeContext(
          runInvitationRegistrationLink({
            orgPath: localOrgRoot,
            email: "settings-e2e@example.com",
            rotate: false,
          }),
        ),
      ),
    )

    expect(output).toContain("http://localhost:3000/register/passkey#token=")
  }, 120_000)

  it.each(["production", "staging"])(
    "fails closed without a configured encryption key when NODE_ENV=%s",
    async (nodeEnv) => {
      const { runInvitationRegistrationLink } = await loadPfcliCommand<{
        runInvitationRegistrationLink: RunInvitationRegistrationLink
      }>("invitation-registration-link")

      const { output } = await withEnv({ ...localEnv, NODE_ENV: nodeEnv }, () =>
        captureStdout(() =>
          runWithNodeContext(
            runInvitationRegistrationLink({
              orgPath: localOrgRoot,
              email: "settings-e2e@example.com",
              rotate: false,
            }),
          ),
        ),
      )

      expect(output).toContain(
        "Registration link encryption is not configured correctly.",
      )
      expect(output).not.toContain("#token=")
    },
    120_000,
  )

  it("does not print local database failure details", async () => {
    const { runInvitationRegistrationLink } = await loadPfcliCommand<{
      runInvitationRegistrationLink: RunInvitationRegistrationLink
    }>("invitation-registration-link")
    const sensitivePathPart = "private-database-token-sentinel"
    const blockingFile = join(localOrgRoot, "not-a-directory")
    writeFileSync(blockingFile, "")
    const inaccessibleDatabasePath = join(blockingFile, sensitivePathPart)

    const { output } = await withEnv(
      { ...localEnv, SQLITE_DATABASE_PATH: inaccessibleDatabasePath },
      () =>
        captureStdout(() =>
          runWithNodeContext(
            runInvitationRegistrationLink({
              email: "settings-e2e@example.com",
              rotate: false,
            }),
          ),
        ),
    )

    expect(output).toContain(
      "Could not access the local database. Check SQLITE_DATABASE_PATH or org-path and try again.",
    )
    expect(output).toMatch(
      /Failure category: (SQL operation|database client initialization) failed\./,
    )
    expect(output).not.toContain(sensitivePathPart)
  }, 120_000)

  it("reports a missing local database without attempting remote access", async () => {
    const { runInvitationRegistrationLink } = await loadPfcliCommand<{
      runInvitationRegistrationLink: RunInvitationRegistrationLink
    }>("invitation-registration-link")
    let fetchCalled = false
    globalThis.fetch = (async () => {
      fetchCalled = true
      throw new Error("fetch should not be called")
    }) as unknown as typeof fetch

    const { output } = await withEnv(localEnv, () =>
      captureStdout(() =>
        runWithNodeContext(
          runInvitationRegistrationLink({
            email: "settings-e2e@example.com",
            rotate: false,
          }),
        ),
      ),
    )

    expect(fetchCalled).toBe(false)
    expect(output).toContain("Database path not configured")
  })
})
