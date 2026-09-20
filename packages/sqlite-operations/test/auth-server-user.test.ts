import { DateTime, Effect } from "effect"
import { createAuthenticationServer } from "@pf/auth-api"
import { type ProviderUserSession, subjects } from "@pf/auth-session"
import * as schema from "@pf/drizzle-sqlite"
import { createTestApp } from "@pf/openauth"
import { createClient } from "@pf/openauth/client"
import { TypedSqliteDrizzle } from "@pf/service-drizzle-sqlite"
import { TestLayer, setupTestData } from "./auth-server.fixture.js"
import { describe, expect, it } from "bun:test"

describe("auth-server user authentication", () => {
  const createExistingProviderUser = ({
    email,
    sub,
    orgUnitId,
    roleIds = [],
    name = "Test User",
  }: {
    email: string
    sub: string
    orgUnitId: string
    roleIds?: string[]
    name?: string
  }) =>
    Effect.gen(function* () {
      const db = yield* TypedSqliteDrizzle
      const now = yield* DateTime.now
      const [firstName, ...lastNameParts] = name.split(" ")

      const [user] = yield* db
        .insert(schema.user)
        .values({
          provider: "google",
          sub,
          lastLoggedIn: now,
        })
        .returning()

      if (!user) throw new Error("Failed to create user")

      const [providerUser] = yield* db
        .insert(schema.providerUser)
        .values({
          userId: user.id,
          email,
          name,
          firstName: firstName ?? name,
          lastName: lastNameParts.join(" "),
          picture: "",
          locale: "en",
          orgUnitId,
        })
        .returning()

      if (!providerUser) throw new Error("Failed to create provider user")

      if (roleIds.length > 0) {
        yield* db.insert(schema.providerUserRole).values(
          roleIds.map((roleId) => ({
            providerUserId: providerUser.id,
            roleId,
          })),
        )
      }

      return providerUser
    })

  const runDummyLogin = (dummyConfig: {
    email: string
    sub: string
    name?: string
  }) =>
    Effect.gen(function* () {
      const { app: issuerApp, runtime } = yield* createAuthenticationServer({
        dummyConfig,
        clients: [
          {
            id: "test-client",
            redirectUris: ["https://test.example.com/callback"],
          },
        ],
      })
      const auth = createTestApp(issuerApp, { runtime })

      const client = createClient({
        issuer: "https://auth.example.com",
        clientID: "test-client",
        fetch: (a, b) => Promise.resolve(auth.request(a, b)),
      })

      const { challenge, url } = yield* Effect.promise(() =>
        client.authorize("https://test.example.com/callback", "code", {
          pkce: true,
        }),
      )

      let response: Response = yield* Effect.promise<Response>(() =>
        auth.request(url),
      )
      expect(response.status).toBe(302)

      response = yield* Effect.promise<Response>(() =>
        auth.request(response.headers.get("location")!, {
          headers: {
            cookie: response.headers.get("set-cookie")!,
          },
        }),
      )
      expect(response.status).toBe(302)

      return { challenge, client, response }
    })

  it("should authenticate an existing dummy user and return correct JWT claims", async () => {
    const testEmail = "tester@example.com"
    const testSub = "dummy-tester-sub"
    const testName = "Test Tester"

    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const testData = yield* setupTestData(testEmail)

          yield* createExistingProviderUser({
            email: testEmail,
            sub: "google-tester-sub",
            name: testName,
            orgUnitId: testData.rootOrgUnitId,
            roleIds: [testData.testerRoleId],
          })

          const { challenge, client, response } = yield* runDummyLogin({
            email: testEmail,
            sub: testSub,
            name: testName,
          })

          const location = new URL(response.headers.get("location")!)
          const code = location.searchParams.get("code")
          expect(code).not.toBeNull()

          const exchanged = yield* Effect.promise(() =>
            client.exchange(
              code!,
              "https://test.example.com/callback",
              challenge.verifier,
            ),
          )
          if (exchanged.err) throw exchanged.err

          const tokens = exchanged.tokens
          expect(tokens.access).toBeDefined()
          expect(tokens.refresh).toBeDefined()

          const verified = yield* Effect.promise(() =>
            client.verify(subjects, tokens.access),
          )
          if (verified.err) throw verified.err

          expect(verified.subject.type).toBe("providerUser")
          const props = verified.subject.properties as ProviderUserSession

          expect(props.email).toBe(testEmail)
          expect(props.orgUnitId).toBe(testData.rootOrgUnitId)
          expect(props.orgUnitPath).toBe(testData.rootOrgUnitPath)
          expect(props.orgUnitPath).toBe("/")
          expect(props.roles).toBeDefined()
          expect(props.roles).toContain(testData.testerRolePath)
          expect(testData.testerRolePath).toBe("/Tester")
        }),
        TestLayer,
      ),
    )
  })

  it("should reject dummy login when no existing user matches email", async () => {
    const testEmail = "newuser@example.com"
    const testSub = "dummy-newuser-sub"

    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const db = yield* TypedSqliteDrizzle

          yield* db.insert(schema.orgUnit).values({
            name: "Root Organization",
            orgUnitLevel: "root",
            path: "/",
            parentOrgUnitId: null,
          })

          const { response } = yield* runDummyLogin({
            email: testEmail,
            sub: testSub,
          })

          const location = new URL(response.headers.get("location")!)
          expect(location.searchParams.get("code")).toBeNull()
          expect(location.searchParams.get("error")).toBe("access_denied")
          expect(location.searchParams.get("error_description")).toBe(
            `Dummy login requires an existing user, but the given bypass user ${testEmail} does not exist in the database. Please set PF_BYPASS_AUTH to a valid user.`,
          )
        }),
        TestLayer,
      ),
    )
  })

  it("should switch org unit when refreshing with a permitted role from different department", async () => {
    const testEmail = "switcher@example.com"
    const testSub = "dummy-switcher-sub"
    const testName = "Role Switcher"

    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const db = yield* TypedSqliteDrizzle

          const [rootOrgUnit] = yield* db
            .insert(schema.orgUnit)
            .values({
              name: "Root Organization",
              orgUnitLevel: "root",
              path: "/",
              parentOrgUnitId: null,
            })
            .returning()

          if (!rootOrgUnit) throw new Error("Failed to create root org unit")

          const [financeOrgUnit] = yield* db
            .insert(schema.orgUnit)
            .values({
              name: "Finance Department",
              orgUnitLevel: "department",
              path: "/Finance/",
              parentOrgUnitId: rootOrgUnit.id,
            })
            .returning()

          if (!financeOrgUnit)
            throw new Error("Failed to create finance org unit")

          const [homeRole] = yield* db
            .insert(schema.role)
            .values({
              name: "Employee",
              orgUnitId: rootOrgUnit.id,
              path: "/Employee",
            })
            .returning()

          if (!homeRole) throw new Error("Failed to create home role")

          const [financeRole] = yield* db
            .insert(schema.role)
            .values({
              name: "Auditor",
              orgUnitId: financeOrgUnit.id,
              path: "/Finance/Auditor",
            })
            .returning()

          if (!financeRole) throw new Error("Failed to create finance role")

          const providerUser = yield* createExistingProviderUser({
            email: testEmail,
            sub: "google-switcher-sub",
            name: testName,
            orgUnitId: rootOrgUnit.id,
            roleIds: [homeRole.id],
          })

          const { challenge, client, response } = yield* runDummyLogin({
            email: testEmail,
            sub: testSub,
            name: testName,
          })

          const location = new URL(response.headers.get("location")!)
          const code = location.searchParams.get("code")
          expect(code).not.toBeNull()

          const exchanged = yield* Effect.promise(() =>
            client.exchange(
              code!,
              "https://test.example.com/callback",
              challenge.verifier,
            ),
          )
          if (exchanged.err) throw exchanged.err

          const initialVerified = yield* Effect.promise(() =>
            client.verify(subjects, exchanged.tokens.access),
          )
          if (initialVerified.err) throw initialVerified.err

          expect(initialVerified.subject.type).toBe("providerUser")
          const initialProps = initialVerified.subject
            .properties as ProviderUserSession
          expect(initialProps.orgUnitId).toBe(rootOrgUnit.id)
          expect(initialProps.orgUnitPath).toBe("/")
          expect(initialProps.roles).toContain("/Employee")

          yield* db.insert(schema.permittedRole).values({
            providerUserId: providerUser.id,
            roleId: financeRole.id,
          })

          const refreshed = yield* Effect.promise(() =>
            client.refresh(exchanged.tokens.refresh, {
              scope: `role:${encodeURIComponent("/Finance/Auditor")}`,
            }),
          )
          if (refreshed.err) throw refreshed.err
          if (!refreshed.tokens) throw new Error("No tokens returned")

          const switchedVerified = yield* Effect.promise(() =>
            client.verify(subjects, refreshed.tokens!.access),
          )
          if (switchedVerified.err) throw switchedVerified.err

          const switchedProps = switchedVerified.subject
            .properties as ProviderUserSession

          expect(switchedProps.orgUnitId).toBe(financeOrgUnit.id)
          expect(switchedProps.orgUnitPath).toBe("/Finance/")
          expect(switchedProps.roles).toEqual(["/Finance/Auditor"])

          const switchedBack = yield* Effect.promise(() =>
            client.refresh(refreshed.tokens!.refresh, {
              scope: `role:${encodeURIComponent("/Employee")}`,
            }),
          )
          if (switchedBack.err) throw switchedBack.err
          if (!switchedBack.tokens) throw new Error("No tokens returned")

          const backVerified = yield* Effect.promise(() =>
            client.verify(subjects, switchedBack.tokens!.access),
          )
          if (backVerified.err) throw backVerified.err

          const backProps = backVerified.subject
            .properties as ProviderUserSession

          expect(backProps.orgUnitId).toBe(rootOrgUnit.id)
          expect(backProps.orgUnitPath).toBe("/")
          expect(backProps.roles).toEqual(["/Employee"])
        }),
        TestLayer,
      ),
    )
  })

  it("should keep original org unit when refreshing with own employee role", async () => {
    const testEmail = "keeper@example.com"
    const testSub = "dummy-keeper-sub"
    const testName = "Org Keeper"

    await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const db = yield* TypedSqliteDrizzle

          const [rootOrgUnit] = yield* db
            .insert(schema.orgUnit)
            .values({
              name: "Root Organization",
              orgUnitLevel: "root",
              path: "/",
              parentOrgUnitId: null,
            })
            .returning()

          if (!rootOrgUnit) throw new Error("Failed to create root org unit")

          const [role1] = yield* db
            .insert(schema.role)
            .values({
              name: "Manager",
              orgUnitId: rootOrgUnit.id,
              path: "/Manager",
            })
            .returning()

          const [role2] = yield* db
            .insert(schema.role)
            .values({
              name: "Developer",
              orgUnitId: rootOrgUnit.id,
              path: "/Developer",
            })
            .returning()

          if (!role1 || !role2) throw new Error("Failed to create roles")

          yield* createExistingProviderUser({
            email: testEmail,
            sub: "google-keeper-sub",
            name: testName,
            orgUnitId: rootOrgUnit.id,
            roleIds: [role1.id, role2.id],
          })

          const { challenge, client, response } = yield* runDummyLogin({
            email: testEmail,
            sub: testSub,
            name: testName,
          })

          const location = new URL(response.headers.get("location")!)
          const code = location.searchParams.get("code")
          expect(code).not.toBeNull()

          const exchanged = yield* Effect.promise(() =>
            client.exchange(
              code!,
              "https://test.example.com/callback",
              challenge.verifier,
            ),
          )
          if (exchanged.err) throw exchanged.err

          const initialVerified = yield* Effect.promise(() =>
            client.verify(subjects, exchanged.tokens.access),
          )
          if (initialVerified.err) throw initialVerified.err

          expect(initialVerified.subject.type).toBe("providerUser")
          const initialProps2 = initialVerified.subject
            .properties as ProviderUserSession
          expect(initialProps2.orgUnitId).toBe(rootOrgUnit.id)
          expect(initialProps2.roles).toContain("/Manager")
          expect(initialProps2.roles).toContain("/Developer")

          const refreshed = yield* Effect.promise(() =>
            client.refresh(exchanged.tokens.refresh, {
              scope: `role:${encodeURIComponent("/Manager")}`,
            }),
          )
          if (refreshed.err) throw refreshed.err
          if (!refreshed.tokens) throw new Error("No tokens returned")

          const switchedVerified = yield* Effect.promise(() =>
            client.verify(subjects, refreshed.tokens!.access),
          )
          if (switchedVerified.err) throw switchedVerified.err

          const switchedProps2 = switchedVerified.subject
            .properties as ProviderUserSession

          expect(switchedProps2.orgUnitId).toBe(rootOrgUnit.id)
          expect(switchedProps2.orgUnitPath).toBe("/")
          expect(switchedProps2.roles).toEqual(["/Manager"])
        }),
        TestLayer,
      ),
    )
  })
})
