import { readFileSync } from "node:fs"
import { FileSystem } from "@effect/platform"
import { SqlClient } from "@effect/sql"
import { DateTime, Effect, FiberRef, Layer, Runtime, Schema } from "effect"
import { buildSchema, defaultFieldResolver, graphql } from "graphql"
import {
  LocalCedarAuthorizationLive,
  LocalCedarConfig,
  getDefaultPoliciesPath,
  getDefaultSchemaPath,
} from "@pf/auth-local-cedar"
import { buildDynamicSchema } from "@pf/org-to-graphql-schema"
import { List, Organisation, OrganisationProvider, Role } from "@pf/process"
import { RequestTime } from "@pf/request-time"
import { DatabaseTest } from "@pf/service-drizzle-sqlite/test"
import { dynamicSchema } from "../../../../packages/graphql-api/src/lib/dynamic-resolvers"
import { DynamicSchemaConfig } from "../../../../packages/graphql-api/src/lib/graphql-api"
import type { UserContext } from "../../../../packages/graphql-api/src/lib/types"
import { SqliteProcessQueriesLive } from "../../../../packages/sqlite-operations/src/lib/query-processes"
import { addListCreationFixture } from "../test-support/list-creation-fixture"
import { describe, expect, it } from "bun:test"

const org = new Organisation({ name: "List create test" })
const role = new Role(org, "Employee")
addListCreationFixture(org, role)
new List(org, "legacy", {
  name: "Legacy",
  roles: [role],
  output: { id: Schema.String },
  query: () => Effect.succeed({ items: [], totalCount: 0 }),
})
const orgLayer = Layer.succeed(OrganisationProvider, {
  organisation: org,
  orgPath: "/tmp/list-create",
  schemaPath: "/tmp/list-create.graphql",
})
const authLayer = LocalCedarAuthorizationLive.pipe(
  Layer.provide(
    Layer.succeed(LocalCedarConfig, {
      schemaText: readFileSync(getDefaultSchemaPath(), "utf8"),
      policiesText: [
        readFileSync(getDefaultPoliciesPath(), "utf8"),
        'permit(principal == PF::ProviderUser::"creator@example.com", action == PF::Action::"create", resource == PF::List::"/contacts");',
      ],
    }),
  ),
)
const database = SqliteProcessQueriesLive.pipe(Layer.provideMerge(DatabaseTest))
const context = (email: string): UserContext => ({
  userId: email,
  _requestTime: DateTime.unsafeMake("2026-09-17T00:00:00Z"),
  _userDetails: { by: email, id: email },
  jwt: {
    mode: "access",
    type: "user",
    properties: {
      userId: email,
      email,
      roles: ["/Employee"],
      orgUnitId: "/",
      orgUnitPath: "/",
    },
    aud: "graphql-api",
    iss: "test",
    sub: email,
    exp: 0,
    iat: 0,
  },
})
const input = {
  name: "Alex",
  email: "alex@example.com",
  date: "2026-09-17T00:00:00.000Z",
  category: "Member",
}
const create =
  "mutation($input: CreateContacts!) { createListItemContacts(input: $input) }"

describe("List creation through generated GraphQL, Cedar and SQLite", () => {
  it("validates, denies unauthorized creation, persists and reopens without execution or Todo", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const sdl = yield* buildDynamicSchema()
          // A list with no create callback has no input type or mutation.
          expect(sdl).not.toContain("createListItemLegacy")
          expect(sdl).not.toContain("input CreateLegacy")
          const generated = yield* dynamicSchema.pipe(
            Effect.provide(
              Layer.mergeAll(
                Layer.succeed(DynamicSchemaConfig, {
                  schemaPath: "/tmp/list-create.graphql",
                }),
                Layer.succeed(
                  FileSystem.FileSystem,
                  FileSystem.makeNoop({
                    exists: () => Effect.succeed(true),
                    readFileString: () => Effect.succeed(sdl),
                  }),
                ),
              ),
            ),
          )
          const schema = buildSchema(
            `scalar DateTimeISO\ninput ListSortInput { field: String! direction: ListSortDirection! }\nenum ListSortDirection { ASC DESC }\n${sdl}`,
          )
          const runtime = yield* Effect.runtime<
            | SqlClient.SqlClient
            | import("@pf/auth-policy").AuthorizationService
            | RequestTime
          >()
          const execute = (
            source: string,
            variables: Record<string, unknown> = {},
            email = "creator@example.com",
          ) =>
            Effect.promise(() =>
              graphql({
                schema,
                source,
                variableValues: variables,
                contextValue: context(email),
                fieldResolver: (parent, args, ctx, info) => {
                  const resolver =
                    info.parentType.name === "Mutation"
                      ? generated.resolvers?.Mutation?.[info.fieldName]
                      : info.parentType.name === "Query"
                        ? generated.resolvers?.Query?.[info.fieldName]
                        : undefined
                  if (typeof resolver !== "function")
                    return defaultFieldResolver(parent, args, ctx, info)
                  return Runtime.runPromise(runtime)(
                    resolver(parent, args, ctx, info),
                  )
                },
              }),
            )
          const empty = yield* execute(
            "{ listContacts { totalCount items { id } } }",
          )
          expect(empty.errors).toBeUndefined()
          expect(empty.data?.["listContacts"]).toEqual({
            totalCount: 0,
            items: [],
          })
          for (const invalid of [
            { ...input, name: "" },
            { ...input, email: "invalid" },
            { ...input, category: "Unknown" },
            { ...input, id: "overridden" },
            { ...input, summary: "overridden" },
            { ...input, date: "not-a-date" },
            { email: input.email, date: input.date, category: input.category },
          ]) {
            const result = yield* execute(create, { input: invalid })
            expect(result.errors?.length).toBeGreaterThan(0)
          }
          const denied = yield* execute(create, { input }, "viewer@example.com")
          expect(denied.errors?.[0]?.message).toContain("not authorized")
          const result = yield* execute(create, { input })
          expect(result.errors).toBeUndefined()
          const id = result.data?.["createListItemContacts"]
          expect(typeof id).toBe("string")
          const reopened = yield* execute(
            "query($id: String!) { listItemContacts(id: $id) { id name email date category summary } }",
            { id },
          )
          expect(reopened.errors).toBeUndefined()
          expect(reopened.data?.["listItemContacts"]).toEqual({
            id,
            ...input,
            summary: "Alex — Member",
          })
          const duplicate = yield* execute(create, { input })
          expect(duplicate.errors?.[0]?.message).toContain(
            "email already exists",
          )
          const sql = yield* SqlClient.SqlClient
          expect(
            yield* sql`SELECT count(*) AS count FROM list_creation_fixture`,
          ).toEqual([{ count: 1 }])
          expect(
            yield* sql`SELECT count(*) AS count FROM pf_process_execution`,
          ).toEqual([{ count: 0 }])
          expect(yield* sql`SELECT count(*) AS count FROM pf_to_do`).toEqual([
            { count: 0 },
          ])
        }).pipe(
          Effect.provide(orgLayer),
          Effect.provide(authLayer),
          Effect.provide(database),
          Effect.provide(
            Layer.effect(
              RequestTime,
              FiberRef.make(DateTime.unsafeMake("2026-09-17T00:00:00Z")),
            ),
          ),
        ),
      ),
    )
  })
})
