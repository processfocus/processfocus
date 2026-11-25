import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { NodeFileSystem } from "@effect/platform-node"
import { QueueService } from "@processfocus/runtime"
import { eq } from "drizzle-orm"
import {
  Context,
  DateTime,
  Effect,
  Layer,
  ManagedRuntime,
  Option,
  Schema,
} from "effect"
import { buildSchema, defaultFieldResolver, graphql } from "graphql"
import * as tables from "@pf/drizzle-sqlite"
import type { UserContext } from "@pf/graphql-api"
import { UserDetails } from "@pf/graphql-db-operations"
import {
  flowExecutionHandler,
  makeNotificationDeliveryConfig,
} from "@pf/job-handler"
import { storeOrganisation } from "@pf/org-to-db"
import {
  ConditionEvaluator,
  ForEachItemsResolver,
  OrganisationProvider,
  OrganisationProviderFromPath,
  ScheduleEvaluator,
  isOrganisation,
  makeConditionEvaluator,
  makeForEachItemsResolver,
  makeScheduleEvaluator,
} from "@pf/process"
import { RequestTime } from "@pf/request-time"
import {
  DatabaseTest,
  TypedSqliteDrizzle,
} from "@pf/service-drizzle-sqlite/test"
import {
  SqliteCompletedJobOperationsLive,
  SqliteDbOperationsLive,
  SqliteFlowExecutionOperationsLive,
  SqliteGraphqlDbOperationsLive,
  SqliteScheduledFlowOperationsLive,
} from "@pf/sqlite-operations"
import { SqliteQueueServiceLive } from "@pf/sqlite-queue-service"
import { dynamicSchema } from "../../../../packages/graphql-api/src/lib/dynamic-resolvers"
import { DynamicSchemaConfig } from "../../../../packages/graphql-api/src/lib/graphql-api"
import { makeAuthorizationLayer } from "../test-support/queue-auth-stubs"

const directory = process.argv[2]
assert(directory, "artifact directory required")
const organisationLayer = OrganisationProviderFromPath(directory).pipe(
  Layer.provide(NodeFileSystem.layer),
)
const provider = await Effect.runPromise(
  Effect.gen(function* () {
    return yield* OrganisationProvider
  }).pipe(Effect.provide(organisationLayer)),
)
const org = provider.organisation
assert(isOrganisation(org), "artifact must contain an Organisation")
const persistence = Layer.mergeAll(
  SqliteDbOperationsLive,
  SqliteGraphqlDbOperationsLive,
  SqliteFlowExecutionOperationsLive,
  SqliteScheduledFlowOperationsLive,
  SqliteCompletedJobOperationsLive,
).pipe(Layer.provideMerge(DatabaseTest))
const base = Layer.mergeAll(
  persistence,
  organisationLayer,
  Layer.succeed(RequestTime, DateTime.nowUnsafe()),
  Layer.succeed(UserDetails, {
    by: "employee@example.com",
    id: "employee@example.com",
  }),
  makeAuthorizationLayer({
    canCompleteStep: () => Effect.succeed(true),
    canModifyField: () => Effect.succeed(true),
    canPerformAction: () => Effect.succeed(true),
  }),
  NodeFileSystem.layer,
)
const app = Layer.mergeAll(
  base,
  SqliteQueueServiceLive.pipe(Layer.provide(base)),
  Layer.succeed(DynamicSchemaConfig, {
    schemaPath: provider.schemaPath,
  }),
  Layer.succeed(ConditionEvaluator, makeConditionEvaluator(org)),
  Layer.succeed(ScheduleEvaluator, makeScheduleEvaluator(org)),
  Layer.succeed(ForEachItemsResolver, makeForEachItemsResolver(org)),
  makeNotificationDeliveryConfig(() => "http://localhost"),
)
const runtime = ManagedRuntime.make(app)
try {
  await runtime.runPromise(storeOrganisation(org))
  await runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* TypedSqliteDrizzle
      const unit = (yield* db
        .select()
        .from(tables.orgUnit)
        .where(eq(tables.orgUnit.path, "/")))[0]
      const role = (yield* db
        .select()
        .from(tables.role)
        .where(eq(tables.role.path, "/Employee")))[0]
      assert(unit && role)
      yield* db.insert(tables.user).values({
        id: "employee@example.com",
        provider: "test",
        sub: "employee@example.com",
        createdAt: DateTime.nowUnsafe(),
      })
      yield* db.insert(tables.providerUser).values({
        id: "employee@example.com",
        userId: "employee@example.com",
        email: "employee@example.com",
        name: "Employee",
        firstName: "Employee",
        lastName: "",
        picture: "",
        locale: "en",
        orgUnitId: unit.id,
      })
      yield* db
        .insert(tables.providerUserRole)
        .values({ providerUserId: "employee@example.com", roleId: role.id })
    }),
  )
  const generated = await runtime.runPromise(dynamicSchema)
  const schema = buildSchema(
    `scalar DateTimeISO\ntype Query { health: Boolean }\n${readFileSync(provider.schemaPath, "utf8")}`,
  )
  const context: UserContext = {
    userId: "employee@example.com",
    _requestTime: DateTime.nowUnsafe(),
    _userDetails: { by: "employee@example.com", id: "employee@example.com" },
    jwt: {
      mode: "access",
      type: "user",
      properties: {
        userId: "employee@example.com",
        email: "employee@example.com",
        roles: ["/Employee"],
        orgUnitId: "/",
        orgUnitPath: "/",
      },
      aud: "graphql-api",
      iss: "test",
      sub: "employee@example.com",
      exp: 0,
      iat: 0,
    },
  }
  const services = await runtime.runPromise(
    Effect.context<Layer.Success<typeof app>>(),
  )
  const workerContext = Context.makeUnsafe<unknown>(services.mapUnsafe)
  const execute = (source: string, variables: Record<string, unknown>) =>
    graphql({
      schema,
      source,
      variableValues: variables,
      contextValue: context,
      fieldResolver: (parent, args, ctx, info) => {
        const entry =
          info.parentType.name === "Mutation"
            ? generated.resolvers?.Mutation?.[info.fieldName]
            : undefined
        const resolver = entry?.resolve ?? entry
        if (typeof resolver !== "function")
          return defaultFieldResolver(parent, args, ctx, info)
        return Effect.runPromiseWith(workerContext)(
          resolver(parent, args, ctx, info),
        )
      },
    })
  const input = {
    name: "Chair",
    accepted: true,
    date: "2026-10-14T00:00:00.000Z",
  }
  const started = await execute(
    "mutation($input: WorkSubmit!) { startWork(input: $input) { executionId } }",
    { input },
  )
  assert.equal(started.errors, undefined, JSON.stringify(started.errors))
  const { executionId } = Schema.decodeUnknownSync(
    Schema.Struct({ executionId: Schema.String }),
  )(started.data?.["startWork"])
  await runtime.runPromise(
    Effect.gen(function* () {
      const queue = yield* QueueService
      const job = Option.getOrThrow(yield* queue.rawClaim("flow-execution"))
      const payload = yield* Schema.decodeUnknownEffect(
        flowExecutionHandler.schema,
      )(job.payload)
      yield* flowExecutionHandler
        .handle({ ...job, payload })
        .pipe(Effect.provide(workerContext))
      yield* queue.acknowledge(job.jobId, job.receipt)
    }),
  )
  const todo = await runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* TypedSqliteDrizzle
      return (yield* db
        .select()
        .from(tables.toDo)
        .where(eq(tables.toDo.processExecutionId, executionId)))[0]
    }),
  )
  assert(todo, "worker must create a real Todo")
  const completed = await execute(
    "mutation($id: ID!, $input: WorkReview!) { completeWorkReview(todoId: $id, input: $input) { executionId } }",
    { id: todo.id, input: { ...input, name: "Reviewed", accepted: false } },
  )
  assert.equal(completed.errors, undefined, JSON.stringify(completed.errors))
  const completion = Schema.decodeUnknownSync(
    Schema.Struct({ executionId: Schema.String }),
  )(completed.data?.["completeWorkReview"])
  assert.equal(completion.executionId, executionId)
  const stored = await runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* TypedSqliteDrizzle
      return (yield* db
        .select()
        .from(tables.toDo)
        .where(eq(tables.toDo.id, todo.id)))[0]
    }),
  )
  assert(stored?._deleted, "completion must persist")
  const states = await runtime.runPromise(
    Effect.gen(function* () {
      const db = yield* TypedSqliteDrizzle
      return yield* db
        .select({ state: tables.processState.state })
        .from(tables.processState)
    }),
  )
  const storedValues = Schema.decodeUnknownSync(
    Schema.Struct({
      name: Schema.String,
      accepted: Schema.Boolean,
      date: Schema.Struct({ epochMilliseconds: Schema.Number }),
    }),
  )(states[0]?.state)
  assert.deepEqual(storedValues, {
    name: "Reviewed",
    accepted: false,
    date: { epochMilliseconds: 1791936000000 },
  })
  console.log(
    "artifact GraphQL start/completion passed: string, Boolean, UTC date",
  )
} finally {
  await runtime.dispose()
}
