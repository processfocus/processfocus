import { createHash, randomBytes } from "node:crypto"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { ExecutionArgs } from "@envelop/types"
import { eq } from "drizzle-orm"
import {
  Context,
  DateTime,
  Effect,
  FiberRef,
  Layer,
  ManagedRuntime,
  Option,
  Schema,
} from "effect"
import { GraphQLError } from "graphql"
import { handleProtocols, makeHandler } from "graphql-ws/use/bun"
import {
  AuthenticationDatabase,
  DelegationDatabase,
  DelegationSessionServiceIsolated,
  createAuthenticationServer,
  createClientJwt,
} from "../../../packages/auth-api/src/index"
import {
  LocalCedarAuthorizationLive,
  LocalCedarConfigHotReload,
} from "../../../packages/auth-local-cedar/src/index"
import {
  CurrentPrincipal,
  type ProviderUserPrincipal,
} from "../../../packages/auth-policy/src/index"
import * as schema from "../../../packages/drizzle-sqlite/src/index"
import { TextField } from "../../../packages/form-schema/src/index"
import * as Graphql from "../../../packages/graphql-api/src/index"
import {
  UserDetails,
  decodeDelegationAudit,
  issueRegistrationLinkForEmail,
} from "../../../packages/graphql-db-operations/src/index"
import {
  ExecutionFromJobPublishError,
  ExecutionFromJobPublisher,
  ProcessFromJobPublishError,
  ProcessFromJobPublisher,
  TodoFromJobPublishError,
  TodoFromJobPublisher,
  buildTodoChangeEvent,
  executionEventHandler,
  flowExecutionHandler,
  makeNotificationDeliveryConfig,
  processEventHandler,
  todoEventHandler,
} from "../../../packages/job-handler/src/index"
import {
  KeyManagementServiceLive,
  createTestApp,
} from "../../../packages/openauth/src/index"
import { storeOrganisation } from "../../../packages/org-to-db/src/index"
import { buildDynamicSchema } from "../../../packages/org-to-graphql-schema/src/index"
import {
  ConditionEvaluator,
  ForEachItemsResolver,
  Form,
  Organisation,
  OrganisationProviderTest,
  Process,
  Role,
  ScheduleEvaluator,
  makeConditionEvaluator,
  makeForEachItemsResolver,
  makeScheduleEvaluator,
} from "../../../packages/process/src/index"
import { RequestTime } from "../../../packages/request-time/src/index"
import { QueueService } from "../../../packages/runtime/src/index"
import { TypedSqliteDrizzle } from "../../../packages/service-drizzle-sqlite/src/index"
import * as Sqlite from "../../../packages/sqlite-operations/src/index"
import { SqliteDelegationDatabaseLive } from "../../../packages/sqlite-operations/src/lib/delegation-database"
import { TestLayer } from "../../../packages/sqlite-operations/test/auth-server.fixture"
import { SqliteQueueServiceLive } from "../../../packages/sqlite-queue-service/src/index"
import { TodoSummaryComputationLive } from "../../../packages/todo-summary/src/index"
import { DraftProcessEventsLive } from "../src/services/draft-process-events"
import { ExecutionEventsLive } from "../src/services/execution-events"
import {
  LocalDocumentStoreConfig,
  LocalDocumentStoreServiceLive,
} from "../src/services/local-document-store"
import { ProcessEventsLive } from "../src/services/process-events"
import { TodoEventsLive } from "../src/services/todo-events"

// Disposable real Next/auth/GraphQL/SQLite composition, never a public runtime.
const repoRoot = resolve(import.meta.dir, "../../..")
const cwd = join(repoRoot, "apps/frontend")
if (!existsSync(join(cwd, "package.json"))) {
  throw new Error(`Frontend workspace not found at ${cwd}`)
}
const runtimeRoot = mkdtempSync(join(tmpdir(), "pf-delegation-next-"))
const policyPath = join(runtimeRoot, "probe.cedar")
const auditPath = join(runtimeRoot, "audit.json")
const issuanceProbe = process.env["DELEGATION_PROBE_ISSUANCE"] === "true"
const issuancePolicyPath = join(runtimeRoot, "issuance.cedar")
const presentationPolicyPath = join(runtimeRoot, "presentation.cedar")
const issuanceReadPolicy = `permit (principal is PF::Delegation in PF::ProviderUser::"lifecycle-owner@example.test", action == PF::Action::"listDelegationTokens", resource == PF::ProviderUser::"lifecycle-owner@example.test");\n`
const issuancePermitPolicy = `${issuanceReadPolicy}
permit (principal is PF::Delegation in PF::ProviderUser::"lifecycle-owner@example.test", action == PF::Action::"issueDelegationSecret", resource == PF::ProviderUser::"lifecycle-owner@example.test");
permit (principal is PF::Delegation in PF::ProviderUser::"lifecycle-owner@example.test", action == PF::Action::"replaceDelegation", resource is PF::Delegation) when { resource.owner == PF::ProviderUser::"lifecycle-owner@example.test" };
`
writeFileSync(
  issuancePolicyPath,
  issuanceProbe ? issuanceReadPolicy : "// No delegated issuance grants.\n",
)
writeFileSync(presentationPolicyPath, "// No presentation-matrix grants.\n")
writeFileSync(policyPath, "// No additional permits.\n")
// Keep the administrator grant independent of the CLI probe's policy resets.
writeFileSync(
  join(runtimeRoot, "administration.cedar"),
  `permit (principal is PF::Delegation in PF::ProviderUser::"administration-admin@example.test", action in [PF::Action::"listDelegationTokens", PF::Action::"revokeDelegation"], resource);\n`,
)
const frontendPort = Schema.decodeUnknownSync(
  Schema.NumberFromString.pipe(Schema.int(), Schema.between(1024, 65535)),
)(process.env["DELEGATION_PROBE_PORT"] ?? "3398")
const org = new Organisation({ name: "Isolated Delegation Verification" })
const tester = new Role(org, "Tester", { name: "Reviewer" })
new Role(org, "Administrator", { name: "Administrator" })
const processModel = new Process(org, "DelegatedReview", {
  name: "Delegated Review",
  purpose: "Isolated browser verification of delegated ordinary work",
})
const submit = new Form(processModel, "Submit", {
  name: "Submit request",
  role: tester,
  form: () => ({ request: TextField() }),
})
const review = new Form(processModel, "Review", {
  name: "Review request",
  role: tester,
  form: () => ({ decision: TextField() }),
})
processModel.start(submit).next(review).end()
const orgLayer = OrganisationProviderTest(
  org,
  runtimeRoot,
  join(runtimeRoot, "org.graphql"),
)
writeFileSync(
  join(runtimeRoot, "org.graphql"),
  await Effect.runPromise(buildDynamicSchema().pipe(Effect.provide(orgLayer))),
)
const base = Layer.mergeAll(
  TestLayer,
  Layer.mergeAll(
    Sqlite.SqliteDbOperationsLive,
    Sqlite.SqliteGraphqlDbOperationsLive,
    Sqlite.SqliteFileOperationsLive,
    Sqlite.SqliteFlowExecutionOperationsLive,
    Sqlite.SqliteCompletedJobOperationsLive,
    Sqlite.SqliteScheduledFlowOperationsLive,
    Sqlite.SqliteSettingsQueriesLive,
  ).pipe(Layer.provide(TestLayer)),
  SqliteDelegationDatabaseLive.pipe(Layer.provide(TestLayer)),
  LocalCedarAuthorizationLive.pipe(
    Layer.provideMerge(
      LocalCedarConfigHotReload(runtimeRoot, [
        "probe.cedar",
        "administration.cedar",
        "issuance.cedar",
        "presentation.cedar",
      ]),
    ),
  ),
  orgLayer,
  Layer.succeed(RequestTime, FiberRef.unsafeMake(DateTime.unsafeNow())),
  Layer.succeed(
    UserDetails,
    FiberRef.unsafeMake<{ by: string; id: string | null }>({
      by: "SYSTEM",
      id: null,
    }),
  ),
  Layer.succeed(
    CurrentPrincipal,
    FiberRef.unsafeMake<ProviderUserPrincipal | null>(null),
  ),
)
const documentStore = LocalDocumentStoreServiceLive.pipe(
  Layer.provide(
    Layer.succeed(LocalDocumentStoreConfig, {
      baseUrl: () => "http://localhost",
      storagePath: runtimeRoot,
      secret: "isolated-probe",
      maxFileSize: 1024,
    }),
  ),
)
const operations = Layer.mergeAll(
  DelegationSessionServiceIsolated,
  KeyManagementServiceLive,
  SqliteQueueServiceLive,
  Graphql.DraftProcessExecutionCollectionOpsLive,
  Graphql.ProcessCollectionOpsLive,
  Graphql.ProcessDurationServiceLive,
  Graphql.TodoCollectionOpsLive,
  Graphql.ExecutionCollectionOpsLive.pipe(
    Layer.provide(Graphql.SlaCalculationServiceLive),
  ),
  Graphql.SlaCalculationServiceLive,
  TodoSummaryComputationLive,
  Graphql.ListExportServiceLive.pipe(Layer.provide(documentStore)),
).pipe(Layer.provideMerge(base))
const appLayer = Layer.mergeAll(
  operations,
  Graphql.LocalDelegatedRealtime.layer,
  documentStore,
  DraftProcessEventsLive,
  TodoEventsLive,
  ProcessEventsLive,
  ExecutionEventsLive,
  Layer.succeed(Graphql.DynamicSchemaConfig, {
    schemaPath: join(runtimeRoot, "org.graphql"),
  }),
  Layer.succeed(ConditionEvaluator, makeConditionEvaluator(org)),
  Layer.succeed(ScheduleEvaluator, makeScheduleEvaluator(org)),
  Layer.succeed(ForEachItemsResolver, makeForEachItemsResolver(org)),
  makeNotificationDeliveryConfig(() => `http://localhost:${frontendPort}`),
)
const runtime = ManagedRuntime.make(appLayer)
let handler: (request: Request) => Promise<Response> = async () =>
  new Response(null, { status: 503 })
const authServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request) => handler(request),
})
const issuer = authServer.url.origin
let registrationUrl = ""
let reviewerRoleId = ""
let administratorRegistrationUrl = ""
const frontendJwt = await runtime.runPromise(
  Effect.gen(function* () {
    yield* storeOrganisation(org)
    const db = yield* TypedSqliteDrizzle
    const root = (yield* db
      .select()
      .from(schema.orgUnit)
      .where(eq(schema.orgUnit.path, "/")))[0]
    const role = (yield* db
      .select()
      .from(schema.role)
      .where(eq(schema.role.path, "/Tester")))[0]
    if (!root || !role) throw new Error("Probe organisation was not hydrated")
    reviewerRoleId = role.id
    const auth = yield* AuthenticationDatabase
    const owner = yield* auth.createProviderUser({
      email: "next-probe@example.test",
      name: "Next Probe Owner",
      firstName: "Next",
      lastName: "Probe Owner",
      picture: "",
      locale: "en",
      provider: "passkey",
      sub: "next-probe",
      orgUnitId: root.id,
    })
    yield* db.insert(schema.oauthProvider).values({
      providerName: "passkey",
      providerConfig: {
        delegatedAccess: true,
        rpName: "Probe",
        rpID: "localhost",
        origin: `http://localhost:${frontendPort}`,
      },
    })
    const store = yield* DelegationDatabase
    const ownerId = Option.getOrThrow(yield* store.findOwnerId(owner.id))
    yield* db
      .insert(schema.providerUserRole)
      .values({ providerUserId: ownerId, roleId: role.id })
      .onConflictDoNothing()
    yield* store.claimName({
      id: "next-probe-delegation",
      ownerId,
      name: "next-probe-agent",
    })
    yield* store.insertGeneration({
      id: "next-probe-generation",
      delegationId: "next-probe-delegation",
      verifier: createHash("sha256")
        .update(`pfds_${"a".repeat(43)}`)
        .digest("base64url"),
      issuedAt: DateTime.unsafeMake(Date.now()),
      expiresAt: DateTime.unsafeMake(Date.now() + 3_600_000),
    })
    const [invitation] = yield* db
      .insert(schema.invitation)
      .values({
        invitationId: "lifecycle-probe-owner",
        email: "lifecycle-owner@example.test",
        invitationStatus: "pending",
        invitationSource: "dashboard",
        invitationPendingEmail: "lifecycle-owner@example.test",
      })
      .returning()
    if (!invitation) throw new Error("Probe invitation was not created")
    yield* db.insert(schema.invitationRole).values({
      invitationId: invitation.id,
      roleId: role.id,
    })
    const link = yield* issueRegistrationLinkForEmail({
      email: invitation.email,
      rotate: false,
      actor: "SYSTEM",
      organisationScope: "isolated-delegation-probe",
      frontendOrigin: `http://localhost:${frontendPort}`,
      secret: "isolated-registration-probe-key-not-for-deployment",
    })
    if (!link.ok) throw new Error("Probe registration link was not issued")
    registrationUrl = link.registrationLinkUrl
    const [adminRole] = yield* db
      .select()
      .from(schema.role)
      .where(eq(schema.role.path, "/Administrator"))
    if (!adminRole) throw new Error("Administrator role missing")
    const [adminInvitation] = yield* db
      .insert(schema.invitation)
      .values({
        invitationId: "administration-probe-admin",
        email: "administration-admin@example.test",
        invitationStatus: "pending",
        invitationSource: "dashboard",
        invitationPendingEmail: "administration-admin@example.test",
      })
      .returning()
    if (!adminInvitation) throw new Error("Administrator invitation missing")
    yield* db.insert(schema.invitationRole).values([
      { invitationId: adminInvitation.id, roleId: adminRole.id },
      { invitationId: adminInvitation.id, roleId: role.id },
    ])
    const adminLink = yield* issueRegistrationLinkForEmail({
      email: adminInvitation.email,
      rotate: false,
      actor: "SYSTEM",
      organisationScope: "isolated-delegation-probe",
      frontendOrigin: `http://localhost:${frontendPort}`,
      secret: "isolated-registration-probe-key-not-for-deployment",
    })
    if (!adminLink.ok)
      throw new Error("Administrator registration link missing")
    administratorRegistrationUrl = adminLink.registrationLinkUrl
    const server = yield* createAuthenticationServer({
      clients: [
        {
          id: "frontend",
          audience: "graphql-api",
          redirectUris: [`http://localhost:${frontendPort}/api/auth/callback`],
          tokenEndpointAuthMethod: "client_jwt",
        },
      ],
    })
    handler = createTestApp(server.app, { runtime: server.runtime }).request
    return yield* createClientJwt({
      clientId: "frontend",
      issuerUrl: issuer,
      audience: "graphql-api",
    })
  }),
)
const yoga = await runtime.runPromise(
  Graphql.Yoga.pipe(
    Effect.provide(Graphql.YogaLive),
    Effect.provide(Graphql.AppSchemaBuilderLive),
    Effect.provideService(Graphql.ResolverRuntime, runtime),
    Effect.provideService(Graphql.AuthConfig, {
      issuerUrl: issuer,
      issuerUrls: [issuer],
      jwksUri: `${issuer}/.well-known/jwks.json`,
    }),
  ),
)
// Same Yoga/envelop boundary as the local runtime: preserve upgrade cookies,
// connection parameters and resolver context, never synthesize a human actor.
const contextFactoryLock = await Effect.runPromise(Effect.makeSemaphore(1))
const websocket = makeHandler({
  execute: (args: ExecutionArgs) => args.rootValue.execute(args),
  subscribe: (args: ExecutionArgs) => args.rootValue.subscribe(args),
  onSubscribe: async (ctx, _id, payload) => {
    try {
      // graphql-ws does not type Bun's upgrade data; decode at that boundary.
      const upgrade = Schema.decodeUnknownSync(
        Schema.Struct({ request: Schema.instanceOf(Request) }),
      )(ctx.extra.socket.data)
      const { schema, execute, subscribe, contextFactory, parse, validate } =
        yoga.getEnveloped({
          ...ctx,
          connectionParams: ctx.connectionParams,
          request: upgrade.request,
          socket: ctx.extra.socket,
          params: payload,
        })
      const contextValue = await Effect.runPromise(
        contextFactoryLock.withPermits(1)(
          Effect.promise(async () => contextFactory()),
        ),
      )
      const args = {
        schema,
        operationName: payload.operationName,
        document: parse(payload.query),
        variableValues: payload.variables,
        contextValue,
        rootValue: { execute, subscribe },
      }
      const errors = validate(schema, args.document)
      return errors.length ? errors : args
    } catch {
      return [new GraphQLError("Subscription authentication failed")]
    }
  },
})
const graphqlServer = Bun.serve<unknown>({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request, server) => {
    if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      if (
        new URL(request.url).pathname !== "/graphql" ||
        !handleProtocols(request.headers.get("sec-websocket-protocol") ?? "")
      )
        return new Response("Bad Request", { status: 400 })
      if (server.upgrade(request, { data: { request } })) return
      return new Response("Upgrade failed", { status: 500 })
    }
    return yoga.fetch(request, server)
  },
  websocket,
})
writeFileSync(
  join(runtimeRoot, ".graphql-port.json"),
  JSON.stringify({ port: graphqlServer.port }),
)
// Private fixture control only: never composed into a shipped runtime. It can
// shorten a fixture generation's deadline, but cannot extend credentials.
const controlToken = randomBytes(32).toString("base64url")
const controlServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (request.headers.get("authorization") !== `Bearer ${controlToken}`)
      return new Response(null, { status: 401 })
    if (request.method !== "POST") return new Response(null, { status: 405 })
    const input = Schema.decodeUnknownSync(
      Schema.Union(
        Schema.Struct({ operation: Schema.Literal("history") }),
        Schema.Struct({
          operation: Schema.Literal("issuance-policy"),
          permitted: Schema.Boolean,
        }),
        Schema.Struct({
          operation: Schema.Literal("presentation-policy"),
          permitted: Schema.Boolean,
        }),
        Schema.Struct({
          operation: Schema.Literal("secret-login-presentation"),
          visible: Schema.Boolean,
        }),
        Schema.Struct({
          operation: Schema.Literal("expire"),
          generationId: Schema.NonEmptyString,
          remainingSeconds: Schema.optional(
            Schema.Number.pipe(Schema.int(), Schema.between(1, 43_200)),
          ),
        }),
      ),
    )(await request.json())
    return runtime.runPromise(
      Effect.gen(function* () {
        const db = yield* TypedSqliteDrizzle
        if (input.operation === "secret-login-presentation") {
          const providers = yield* db.select().from(schema.oauthProvider)
          for (const provider of providers) {
            const config =
              typeof provider.providerConfig === "object" &&
              provider.providerConfig !== null
                ? provider.providerConfig
                : {}
            yield* db
              .update(schema.oauthProvider)
              .set({
                providerConfig: {
                  ...config,
                  delegatedAccess: input.visible,
                },
              })
              .where(eq(schema.oauthProvider.id, provider.id))
          }
          return Response.json({ visible: input.visible })
        }
        if (input.operation === "presentation-policy") {
          writeFileSync(
            presentationPolicyPath,
            input.permitted
              ? `permit (principal == PF::Delegation::"next-probe-delegation", action in [PF::Action::"listDelegationTokens", PF::Action::"issueDelegationSecret"], resource == PF::ProviderUser::"next-probe@example.test");\n`
              : "// No presentation-matrix grants.\n",
          )
          return Response.json({ permitted: input.permitted })
        }
        if (input.operation === "issuance-policy") {
          if (!issuanceProbe) return new Response(null, { status: 403 })
          writeFileSync(
            issuancePolicyPath,
            input.permitted ? issuancePermitPolicy : issuanceReadPolicy,
          )
          return Response.json({ permitted: input.permitted })
        }
        if (input.operation === "history") {
          const history = yield* db.select().from(schema.delegationHistory)
          const owners = yield* db
            .select({
              id: schema.providerUser.id,
              userId: schema.providerUser.userId,
              email: schema.providerUser.email,
            })
            .from(schema.providerUser)
          const delegations = yield* db
            .select({
              id: schema.delegation.id,
              ownerId: schema.delegation.ownerProviderUserId,
            })
            .from(schema.delegation)
          return Response.json({ history, owners, delegations })
        }
        const [generation] = yield* db
          .select({
            email: schema.providerUser.email,
            expiresAt: schema.secretGeneration.secretExpiresAt,
          })
          .from(schema.secretGeneration)
          .innerJoin(
            schema.delegation,
            eq(schema.delegation.id, schema.secretGeneration.delegationId),
          )
          .innerJoin(
            schema.providerUser,
            eq(schema.providerUser.id, schema.delegation.ownerProviderUserId),
          )
          .where(eq(schema.secretGeneration.id, input.generationId))
        if (
          !generation ||
          (generation.email !== "administration-admin@example.test" &&
            !(
              issuanceProbe &&
              generation.email === "lifecycle-owner@example.test"
            ))
        )
          return new Response(null, { status: 403 })
        const expiresAt = Math.min(
          Math.floor(Date.now() / 1000) * 1000 +
            (issuanceProbe ? (input.remainingSeconds ?? 60) : 60) * 1000,
          DateTime.toEpochMillis(generation.expiresAt),
        )
        yield* db
          .update(schema.secretGeneration)
          .set({ secretExpiresAt: DateTime.unsafeMake(expiresAt) })
          .where(eq(schema.secretGeneration.id, input.generationId))
        const store = yield* DelegationDatabase
        const stored = yield* store.findGeneration({
          generationId: input.generationId,
        })
        if (Option.isNone(stored)) return new Response(null, { status: 404 })
        return Response.json({
          expiresAt: DateTime.toEpochMillis(stored.value.expiresAt),
        })
      }),
    )
  },
})
// Bearer bootstrap material is private, temporary, and never written to logs.
writeFileSync(
  join(runtimeRoot, "browser-handoff.json"),
  JSON.stringify({
    registrationUrl,
    administratorRegistrationUrl,
    issuanceProbe,
    control: controlServer.url.origin,
    controlToken,
    issuer,
    frontend: `http://localhost:${frontendPort}`,
    graphql: `${graphqlServer.url.origin}/graphql`,
    frontendJwt,
    policyPath,
    runtimeRoot,
    auditPath,
    reviewerRoleId,
  }),
  { mode: 0o600 },
)
console.info(
  `Private browser handoff: ${join(runtimeRoot, "browser-handoff.json")}`,
)
const workerServices = await runtime.runPromise(
  Effect.context<Layer.Layer.Success<typeof appLayer>>(),
)
// Worker and GraphQL share a process here, so publish straight into the same
// real local hubs instead of exposing an unauthenticated callback endpoint.
const publishers = await runtime.runPromise(
  Effect.gen(function* () {
    const schema = yoga.getEnveloped().schema
    const todos = yield* Graphql.TodoEvents
    const processes = yield* Graphql.ProcessEvents
    const executions = yield* Graphql.ExecutionEvents
    const processOps = yield* Graphql.ProcessCollectionOps
    const executionOps = yield* Graphql.ExecutionCollectionOps
    const userDetails = yield* UserDetails
    return Context.empty().pipe(
      Context.add(TodoFromJobPublisher, {
        publishTodosCreated: (rows) => {
          const event = buildTodoChangeEvent(rows)
          return event
            ? todos.emit(event, schema).pipe(
                Effect.mapError(
                  (cause) =>
                    new TodoFromJobPublishError({
                      todoIds: rows.map((row) => row.id),
                      cause,
                    }),
                ),
              )
            : Effect.void
        },
      }),
      Context.add(ProcessFromJobPublisher, {
        publishProcessChanged: (processId) =>
          Effect.gen(function* () {
            const rows = yield* processOps.getByIds([processId])
            const documents = yield* Effect.all(
              rows.map((row) => processOps.mapToGraphql(row)),
            )
            const last = documents.at(-1)
            if (!last) return "skipped-not-found" as const
            yield* processes.emit(
              {
                documents,
                checkpoint: { id: last.id, updatedAt: last.updatedAt },
              },
              schema,
            )
            return "published" as const
          }).pipe(
            Effect.provideService(UserDetails, userDetails),
            Effect.mapError(
              (cause) => new ProcessFromJobPublishError({ processId, cause }),
            ),
          ),
      }),
      Context.add(ExecutionFromJobPublisher, {
        publishExecutionChanged: (executionId) =>
          Effect.gen(function* () {
            const rows = yield* executionOps.getByIds([executionId])
            const documents = yield* Effect.all(
              rows.map((row) =>
                executionOps.mapToGraphql(row).pipe(
                  Effect.map((document) => ({
                    ...document,
                    startedByEmail: row.execution.startedByEmail,
                    startedByRolePath: row.execution.startedByRolePath,
                  })),
                ),
              ),
            )
            const last = documents.at(-1)
            if (!last) return "skipped-not-found" as const
            yield* executions.emit(
              {
                documents,
                checkpoint: { id: last.id, updatedAt: last.updatedAt },
              },
              schema,
            )
            return "published" as const
          }).pipe(
            Effect.provideService(UserDetails, userDetails),
            Effect.mapError(
              (cause) =>
                new ExecutionFromJobPublishError({ executionId, cause }),
            ),
          ),
      }),
    )
  }),
)
const workerContext = Context.unsafeMake<unknown>(
  Context.merge(workerServices, publishers).unsafeMap,
)
let stopping = false
const worker = (async () => {
  while (!stopping) {
    await runtime
      .runPromise(
        Effect.gen(function* () {
          yield* FiberRef.set(yield* RequestTime, yield* DateTime.now)
          const queue = yield* QueueService
          const db = yield* TypedSqliteDrizzle
          const executions = yield* db
            .select({
              id: schema.processExecution.id,
              createdBy: schema.processExecution.createdBy,
            })
            .from(schema.processExecution)
          writeFileSync(
            auditPath,
            JSON.stringify(
              executions.map((row) => ({
                id: row.id,
                actor: Option.getOrNull(decodeDelegationAudit(row.createdBy)),
              })),
            ),
            { mode: 0o600 },
          )
          for (const [name, handler] of [
            ["flow-execution", flowExecutionHandler],
            ["todo-event", todoEventHandler],
            ["process-event", processEventHandler],
            ["execution-event", executionEventHandler],
          ] as const) {
            const claimed = yield* queue.rawClaim(name)
            if (Option.isNone(claimed)) continue
            const job = claimed.value
            // Decode and dispatch together to retain each handler's payload type.
            const run = <A>(selected: {
              schema: Schema.Schema<A>
              handle: (
                queuedJob: typeof job & { payload: A },
              ) => Effect.Effect<unknown, unknown, unknown>
            }) =>
              Schema.decodeUnknown(selected.schema)(job.payload).pipe(
                Effect.flatMap((payload) =>
                  selected.handle({ ...job, payload }),
                ),
                Effect.provide(workerContext),
              )
            if (handler === flowExecutionHandler)
              yield* run(flowExecutionHandler)
            else if (handler === todoEventHandler) yield* run(todoEventHandler)
            else if (handler === processEventHandler)
              yield* run(processEventHandler)
            else yield* run(executionEventHandler)
            yield* queue.acknowledge(job.jobId, job.receipt)
          }
        }),
      )
      .catch((error) => console.error("Isolated worker failed", error))
    await Bun.sleep(250)
  }
})()
const child = Bun.spawn(
  [
    "bun",
    "run",
    "--bun",
    "next",
    "dev",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(frontendPort),
  ],
  {
    cwd,
    env: {
      ...process.env,
      NODE_ENV: "development",
      PF_RUNTIME_ROOT: runtimeRoot,
      FRONTEND_JWT_TOKEN: frontendJwt,
      GRAPHQL_ENDPOINT: `http://localhost:${graphqlServer.port}/graphql`,
      NEXT_PUBLIC_WS_ENDPOINT: `ws://localhost:${graphqlServer.port}/graphql`,
      OTEL_SDK_DISABLED: "true",
    },
    stdout: "inherit",
    stderr: "inherit",
  },
)
console.info(
  `Isolated Next ordinary-work probe: http://localhost:${frontendPort}/login`,
)
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => child.kill(signal))
await child.exited
stopping = true
await worker
graphqlServer.stop(true)
controlServer.stop(true)
authServer.stop(true)
await runtime.dispose()
rmSync(runtimeRoot, { recursive: true, force: true })
