import { DateTime, Effect, FileSystem, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { buildSchema, defaultFieldResolver, graphql } from "graphql"
import { buildDynamicSchema } from "@pf/org-to-graphql-schema"
import {
  OrgUnit,
  Organisation,
  OrganisationProviderTest,
  Role,
  normalizePath,
} from "@pf/process"
import { dynamicSchema } from "../../../packages/graphql-api/src/lib/dynamic-resolvers"
import { DynamicSchemaConfig } from "../../../packages/graphql-api/src/lib/graphql-api"
import type { UserContext } from "../../../packages/graphql-api/src/lib/types"
import { sqliteDbCase } from "../../../runtime/local/src/test-support/graphql-db-matrix"
import {
  makeAuthorizationLayer,
  makeQueueLayer,
} from "../../../runtime/local/src/test-support/queue-auth-stubs"
import { PurchaseRequest } from "../src/purchase-request"
import { TypedDemoDrizzleLayer } from "../src/schema/typed-drizzle"
import { expect, it } from "bun:test"

it("starts the maintained purchase request through GraphQL, persists decoded values and rejects direct validation bypasses", async () => {
  const org = new Organisation({ name: "Purchase request contract" })
  const unit = new OrgUnit(org, "finance", {
    name: "Finance",
    type: "department",
  })
  const employee = new Role(unit, "employee", { name: "Employee" })
  const manager = new Role(unit, "manager", { name: "Manager" })
  const procurement = new Role(unit, "procurement", { name: "Procurement" })
  const purchase = new PurchaseRequest(
    unit,
    "purchase-request",
    employee,
    manager,
    procurement,
  )
  const rolePath = normalizePath(employee.node.path)
  const orgUnitPath = normalizePath(unit.node.path)
  const email = "employee@example.com"
  const context: UserContext = {
    userId: email,
    _requestTime: DateTime.makeUnsafe("2026-10-14T00:00:00Z"),
    _userDetails: { by: email, id: email },
    jwt: {
      mode: "access",
      type: "user",
      properties: {
        userId: email,
        email,
        roles: [rolePath],
        orgUnitId: orgUnitPath,
        orgUnitPath,
      },
      aud: "graphql-api",
      iss: "test",
      sub: email,
      exp: 0,
      iat: 0,
    },
  }
  const database = TypedDemoDrizzleLayer.pipe(
    Layer.provideMerge(sqliteDbCase.layer),
  )
  const services = Layer.mergeAll(
    database,
    OrganisationProviderTest(org),
    makeQueueLayer([]),
    makeAuthorizationLayer({ canCompleteStep: () => Effect.succeed(true) }),
  )
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const migration = yield* Effect.promise(() =>
          Bun.file(
            new URL(
              "../drizzle/20260209220402_lame_white_queen/migration.sql",
              import.meta.url,
            ),
          ).text(),
        )
        yield* sql.unsafe(migration)
        yield* sql`INSERT INTO purchase_order (id, item, price) VALUES ('existing', 'Purchased laptop', 500)`
        yield* sqliteDbCase.storeOrganisation(org)
        yield* sqliteDbCase.ensureProviderUser({
          email,
          rolePaths: [rolePath],
          orgUnitPath,
        })
        const processId = yield* sqliteDbCase.getProcessIdByPath(
          normalizePath(purchase.node.path),
        )
        const sdl = yield* buildDynamicSchema()
        const generated = yield* dynamicSchema.pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(DynamicSchemaConfig, {
                schemaPath: "/tmp/purchase-request.graphql",
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
          `scalar DateTimeISO\ntype Query { ready: Boolean }\n${sdl}`,
        )
        const mutation = purchase.startMutationName()
        const inputType = schema
          .getMutationType()
          ?.getFields()
          [mutation]?.args.find((arg) => arg.name === "input")?.type
        expect(inputType).toBeDefined()
        const runtime = yield* Effect.context<Layer.Success<typeof services>>()
        const submit = (input: {
          item: string
          value: string
          referenceOrderId?: string
        }) =>
          Effect.promise(() =>
            graphql({
              schema,
              source: `mutation($input: ${inputType}) { ${mutation}(input: $input) { executionId } }`,
              variableValues: { input },
              contextValue: context,
              fieldResolver: (parent, args, ctx, info) => {
                const entry =
                  info.parentType.name === "Mutation"
                    ? generated.resolvers?.Mutation?.[info.fieldName]
                    : undefined
                const resolver = entry?.resolve ?? entry
                return typeof resolver === "function"
                  ? Effect.runPromiseWith(runtime)(
                      resolver(parent, args, ctx, info),
                    )
                  : defaultFieldResolver(parent, args, ctx, info)
              },
            }),
          )
        for (const [input, message] of [
          [{ item: "   ", value: "123.45" }, "Enter an item to purchase"],
          [
            { item: "New laptop", value: "-1" },
            "Value must be greater than zero",
          ],
          [
            { item: "  Purchased laptop  ", value: "123.45" },
            "This item has already been purchased",
          ],
        ] as const) {
          const rejected = yield* submit(input)
          expect(
            rejected.errors?.map((error) => error.message).join("\n"),
          ).toContain(message)
          expect(
            yield* sqliteDbCase.getProcessStatesByProcessId(processId),
          ).toEqual([])
        }
        const accepted = yield* submit({
          item: "  New laptop  ",
          value: "123.45",
          referenceOrderId: "existing",
        })
        expect(accepted.errors).toBeUndefined()
        expect(accepted.data?.[mutation]).toMatchObject({
          executionId: expect.any(String),
        })
        const states =
          yield* sqliteDbCase.getProcessStatesByProcessId(processId)
        expect(states).toHaveLength(1)
        expect(states[0]?.state).toMatchObject({
          item: "New laptop",
          value: 123.45,
          referenceOrderId: "existing",
        })
      }).pipe(Effect.provide(services)),
    ),
  )
})
