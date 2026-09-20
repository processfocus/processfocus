import { and, eq } from "drizzle-orm"
import { DateTime, Effect, FiberRef, Layer } from "effect"
import * as postgresSchema from "@pf/drizzle-postgres"
import * as sqliteSchema from "@pf/drizzle-sqlite"
import {
  FlowExecutionOperations,
  ProcessExecutionOperations,
  UserDetails,
  type UserDetailsValue,
} from "@pf/graphql-db-operations"
import { storeOrganisation } from "@pf/org-to-db"
import {
  PostgresCompletedJobOperationsLive,
  PostgresDbOperationsLive,
  PostgresFlowExecutionOperationsLive,
  PostgresGraphqlDbOperationsLive,
  PostgresScheduledFlowOperationsLive,
} from "@pf/postgres-operations"
import type { Organisation } from "@pf/process"
import { RequestTime } from "@pf/request-time"
import {
  PostgresTest,
  TypedPostgresDrizzle,
} from "@pf/service-drizzle-postgres/test"
import {
  DatabaseTest as SqliteDatabaseTest,
  TypedSqliteDrizzle,
} from "@pf/service-drizzle-sqlite/test"
import {
  SqliteCompletedJobOperationsLive,
  SqliteDbOperationsLive,
  SqliteFlowExecutionOperationsLive,
  SqliteGraphqlDbOperationsLive,
  SqliteScheduledFlowOperationsLive,
} from "@pf/sqlite-operations"

const fixedRequestTime = DateTime.unsafeMake("2026-04-06T10:00:00.000Z")

const UserDetailsTest = Layer.succeed(
  UserDetails,
  FiberRef.unsafeMake<UserDetailsValue>({
    by: "employee@example.com",
    id: "employee@example.com",
  }),
)

const RequestTimeTest = Layer.succeed(
  RequestTime,
  FiberRef.unsafeMake(fixedRequestTime),
)

const SqliteBaseDbLayer = Layer.provideMerge(
  SqliteDbOperationsLive,
  SqliteDatabaseTest,
)

const SqliteOperationLayer = Layer.provideMerge(
  Layer.mergeAll(
    SqliteGraphqlDbOperationsLive,
    SqliteScheduledFlowOperationsLive,
    SqliteFlowExecutionOperationsLive,
    SqliteCompletedJobOperationsLive,
  ),
  SqliteBaseDbLayer,
)

type SqliteRequirements =
  | Layer.Layer.Success<typeof SqliteBaseDbLayer>
  | Layer.Layer.Success<typeof SqliteOperationLayer>
  | Layer.Layer.Success<typeof RequestTimeTest>
  | Layer.Layer.Success<typeof UserDetailsTest>

const SqliteLayer: Layer.Layer<SqliteRequirements, unknown, never> =
  Layer.mergeAll(
    SqliteBaseDbLayer,
    SqliteOperationLayer,
    RequestTimeTest,
    UserDetailsTest,
  )

type PostgresBaseRequirements =
  | Layer.Layer.Success<typeof PostgresDbOperationsLive>
  | Layer.Layer.Success<typeof PostgresTest>

const PostgresBaseDbLayer: Layer.Layer<
  PostgresBaseRequirements,
  unknown,
  never
> = Layer.provideMerge(PostgresDbOperationsLive, PostgresTest)

type PostgresOperationRequirements =
  | PostgresBaseRequirements
  | Layer.Layer.Success<typeof PostgresGraphqlDbOperationsLive>
  | Layer.Layer.Success<typeof PostgresScheduledFlowOperationsLive>
  | Layer.Layer.Success<typeof PostgresFlowExecutionOperationsLive>
  | Layer.Layer.Success<typeof PostgresCompletedJobOperationsLive>

const PostgresOperationLayer: Layer.Layer<
  PostgresOperationRequirements,
  unknown,
  never
> = Layer.provideMerge(
  Layer.mergeAll(
    PostgresGraphqlDbOperationsLive,
    PostgresScheduledFlowOperationsLive,
    PostgresFlowExecutionOperationsLive,
    PostgresCompletedJobOperationsLive,
  ),
  PostgresBaseDbLayer,
)

type PostgresRequirements =
  | PostgresBaseRequirements
  | PostgresOperationRequirements
  | Layer.Layer.Success<typeof RequestTimeTest>
  | Layer.Layer.Success<typeof UserDetailsTest>

const PostgresLayer: Layer.Layer<PostgresRequirements, unknown, never> =
  Layer.mergeAll(
    PostgresBaseDbLayer,
    PostgresOperationLayer,
    RequestTimeTest,
    UserDetailsTest,
  )

interface ProviderUserSeed {
  readonly email: string
  readonly id?: string
  readonly rolePaths?: readonly string[]
  readonly orgUnitPath?: string
}

interface StoredProcessState {
  readonly id: string
  readonly state: Record<string, unknown>
  readonly startedByExternalParticipantId: string | null
}

interface ProcessStateRow {
  readonly id: string
  readonly state: unknown[] | Record<string, unknown>
  readonly startedByExternalParticipantId: string | null
}

const isJsonObject = (
  state: unknown[] | Record<string, unknown>,
): state is Record<string, unknown> => !Array.isArray(state)

const toStoredProcessState = (
  row: ProcessStateRow,
): Effect.Effect<StoredProcessState> =>
  Effect.gen(function* () {
    if (!isJsonObject(row.state)) {
      return yield* Effect.dieMessage(
        "Expected process state to be a JSON object",
      )
    }

    return { ...row, state: row.state }
  })

interface StoredTodo {
  readonly id: string
  readonly deleted: boolean
  readonly completedByExternalParticipantId: string | null
  readonly completedByRoleId: string | null
  readonly correctionRequiredAt: DateTime.Utc | null
  readonly failureReason: string | null
}

interface StoredPublicCompletionInvitationAttempt {
  readonly id: string
  readonly email: string
  readonly providerMessageId: string | null
  readonly providerSentTo: string | null
  readonly deliveryStatus: string | null
  readonly deliveryEventId: string | null
  readonly deliveryFailureKind: string | null
  readonly deliveryFailureReason: string | null
}

interface StoredProcessExecutionStatus {
  readonly finishedAt: DateTime.Utc | null
  readonly abandonedAt: DateTime.Utc | null
}

export interface GraphqlDbCase<R> {
  readonly name: string
  readonly layer: Layer.Layer<R, unknown, never>
  readonly storeOrganisation: (
    organisation: Organisation,
  ) => Effect.Effect<void, unknown, R>
  readonly ensureProviderUser: (
    input: ProviderUserSeed,
  ) => Effect.Effect<string, unknown, R>
  readonly getProcessIdByPath: (
    path: string,
  ) => Effect.Effect<string, unknown, R>
  readonly getStepIdByPath: (path: string) => Effect.Effect<string, unknown, R>
  readonly getFlowIdByStepPaths: (
    sourceStepPath: string,
    targetStepPath: string,
  ) => Effect.Effect<string, unknown, R>
  readonly getProcessStatesByProcessId: (
    processId: string,
  ) => Effect.Effect<StoredProcessState[], unknown, R>
  readonly getProcessStateByExecutionId: (
    executionId: string,
  ) => Effect.Effect<StoredProcessState | null, unknown, R>
  readonly getScheduledFlowIdsForExecution: (
    executionId: string,
  ) => Effect.Effect<string[], unknown, R>
  readonly getExternalParticipantIdsByEmail: (
    email: string,
  ) => Effect.Effect<string[], unknown, R>
  readonly getTodoById: (
    todoId: string,
  ) => Effect.Effect<StoredTodo | null, unknown, R>
  readonly getPublicCompletionInvitationAttemptsByTodoId: (
    todoId: string,
  ) => Effect.Effect<StoredPublicCompletionInvitationAttempt[], unknown, R>
  readonly getProcessExecutionStatus: (
    executionId: string,
  ) => Effect.Effect<StoredProcessExecutionStatus | null, unknown, R>
  readonly getRoleIdByPath: (
    path: string,
  ) => Effect.Effect<string | null, unknown, R>
  readonly getProcessStateStartedByRole: (
    executionId: string,
  ) => Effect.Effect<string | null, unknown, R>
  readonly getFirstScheduledFlowForExecution: (
    executionId: string,
  ) => Effect.Effect<
    {
      readonly completedByRoleId: string | null
    } | null,
    unknown,
    R
  >
}

export interface SeedActiveTodoInput {
  readonly organisation: Organisation
  readonly orgUnitPath: string
  readonly rolePath: string
  readonly processPath: string
  readonly startStepPath: string
  readonly todoStepPath: string
  readonly providerEmail?: string
  readonly state?: Record<string, unknown>
  readonly itemData?: Record<string, unknown> | unknown[] | null
}

export const seedActiveTodo = <R>(
  db: GraphqlDbCase<R>,
  input: SeedActiveTodoInput,
) =>
  Effect.gen(function* () {
    yield* db.storeOrganisation(input.organisation)
    yield* db.ensureProviderUser({
      email: input.providerEmail ?? "employee@example.com",
      rolePaths: [input.rolePath],
      orgUnitPath: input.orgUnitPath,
    })

    const processId = yield* db.getProcessIdByPath(input.processPath)
    const flowId = yield* db.getFlowIdByStepPaths(
      input.startStepPath,
      input.todoStepPath,
    )

    const processExecutionOps = yield* ProcessExecutionOperations
    const { processStateId, stepId: startStepId } =
      yield* processExecutionOps.insertProcessState(
        processId,
        input.startStepPath,
        input.state ?? {},
      )
    const executionId =
      yield* processExecutionOps.insertProcessExecution(processStateId)

    const flowOps = yield* FlowExecutionOperations
    const slaTargetAt = null
    const slaWarningAt = null
    const todoId = yield* flowOps.insertToDo({
      processExecutionId: executionId,
      flowId,
      slaTargetAt,
      slaWarningAt,
      itemData: input.itemData ?? null,
    })
    const todoStepId = yield* db.getStepIdByPath(input.todoStepPath)

    return {
      executionId,
      flowId,
      processId,
      processStateId,
      startStepId,
      todoId,
      todoStepId,
    }
  })

const ensureSqliteProviderUser = ({
  email,
  id = email,
  rolePaths = [],
  orgUnitPath = "/Operations",
}: ProviderUserSeed): Effect.Effect<string, unknown, SqliteRequirements> =>
  Effect.gen(function* () {
    const db = yield* TypedSqliteDrizzle
    const orgUnit = yield* db
      .select({ id: sqliteSchema.orgUnit.id })
      .from(sqliteSchema.orgUnit)
      .where(eq(sqliteSchema.orgUnit.path, orgUnitPath))
      .limit(1)
    const orgUnitId = orgUnit[0]?.id
    if (!orgUnitId) {
      return yield* Effect.dieMessage(`Missing org unit ${orgUnitPath}`)
    }

    const existingUser = yield* db
      .select({ id: sqliteSchema.user.id })
      .from(sqliteSchema.user)
      .where(eq(sqliteSchema.user.id, email))
      .limit(1)
    if (!existingUser[0]) {
      yield* db.insert(sqliteSchema.user).values({
        id: email,
        provider: "test",
        sub: email,
        lastLoggedIn: fixedRequestTime,
      })
    }

    const existingProviderUser = yield* db
      .select({ id: sqliteSchema.providerUser.id })
      .from(sqliteSchema.providerUser)
      .where(eq(sqliteSchema.providerUser.id, id))
      .limit(1)
    if (!existingProviderUser[0]) {
      yield* db.insert(sqliteSchema.providerUser).values({
        id,
        userId: email,
        email,
        name: email,
        firstName: email,
        lastName: "",
        picture: "",
        locale: "en",
        orgUnitId,
      })
    }

    for (const rolePath of rolePaths) {
      const role = yield* db
        .select({ id: sqliteSchema.role.id })
        .from(sqliteSchema.role)
        .where(eq(sqliteSchema.role.path, rolePath))
        .limit(1)
      const roleId = role[0]?.id
      if (!roleId) {
        return yield* Effect.dieMessage(`Missing role ${rolePath}`)
      }
      const existingRoleLink = yield* db
        .select({ id: sqliteSchema.providerUserRole.id })
        .from(sqliteSchema.providerUserRole)
        .where(
          and(
            eq(sqliteSchema.providerUserRole.providerUserId, id),
            eq(sqliteSchema.providerUserRole.roleId, roleId),
          ),
        )
        .limit(1)
      if (!existingRoleLink[0]) {
        yield* db.insert(sqliteSchema.providerUserRole).values({
          providerUserId: id,
          roleId,
        })
      }
    }

    return id
  })

const ensurePostgresProviderUser = ({
  email,
  id = email,
  rolePaths = [],
  orgUnitPath = "/Operations",
}: ProviderUserSeed): Effect.Effect<string, unknown, PostgresRequirements> =>
  Effect.gen(function* () {
    const db = yield* TypedPostgresDrizzle
    const orgUnit = yield* db
      .select({ id: postgresSchema.orgUnit.id })
      .from(postgresSchema.orgUnit)
      .where(eq(postgresSchema.orgUnit.path, orgUnitPath))
      .limit(1)
    const orgUnitId = orgUnit[0]?.id
    if (!orgUnitId) {
      return yield* Effect.dieMessage(`Missing org unit ${orgUnitPath}`)
    }

    const existingUser = yield* db
      .select({ id: postgresSchema.user.id })
      .from(postgresSchema.user)
      .where(eq(postgresSchema.user.id, email))
      .limit(1)
    if (!existingUser[0]) {
      yield* db.insert(postgresSchema.user).values({
        id: email,
        provider: "test",
        sub: email,
        lastLoggedIn: fixedRequestTime,
      })
    }

    const existingProviderUser = yield* db
      .select({ id: postgresSchema.providerUser.id })
      .from(postgresSchema.providerUser)
      .where(eq(postgresSchema.providerUser.id, id))
      .limit(1)
    if (!existingProviderUser[0]) {
      yield* db.insert(postgresSchema.providerUser).values({
        id,
        userId: email,
        email,
        name: email,
        firstName: email,
        lastName: "",
        picture: "",
        locale: "en",
        orgUnitId,
      })
    }

    for (const rolePath of rolePaths) {
      const role = yield* db
        .select({ id: postgresSchema.role.id })
        .from(postgresSchema.role)
        .where(eq(postgresSchema.role.path, rolePath))
        .limit(1)
      const roleId = role[0]?.id
      if (!roleId) {
        return yield* Effect.dieMessage(`Missing role ${rolePath}`)
      }
      const existingRoleLink = yield* db
        .select({ id: postgresSchema.providerUserRole.id })
        .from(postgresSchema.providerUserRole)
        .where(
          and(
            eq(postgresSchema.providerUserRole.providerUserId, id),
            eq(postgresSchema.providerUserRole.roleId, roleId),
          ),
        )
        .limit(1)
      if (!existingRoleLink[0]) {
        yield* db.insert(postgresSchema.providerUserRole).values({
          providerUserId: id,
          roleId,
        })
      }
    }

    return id
  })

export const sqliteDbCase: GraphqlDbCase<SqliteRequirements> = {
  name: "sqlite",
  layer: SqliteLayer,
  storeOrganisation,
  ensureProviderUser: ensureSqliteProviderUser,
  getProcessIdByPath: (path) =>
    Effect.gen(function* () {
      const db = yield* TypedSqliteDrizzle
      const rows = yield* db
        .select({ id: sqliteSchema.process.id })
        .from(sqliteSchema.process)
        .where(eq(sqliteSchema.process.path, path))
        .limit(1)
      return (
        rows[0]?.id ?? (yield* Effect.dieMessage(`Missing process ${path}`))
      )
    }),
  getStepIdByPath: (path) =>
    Effect.gen(function* () {
      const db = yield* TypedSqliteDrizzle
      const rows = yield* db
        .select({ id: sqliteSchema.step.id })
        .from(sqliteSchema.step)
        .where(eq(sqliteSchema.step.path, path))
        .limit(1)
      return rows[0]?.id ?? (yield* Effect.dieMessage(`Missing step ${path}`))
    }),
  getFlowIdByStepPaths: (sourceStepPath, targetStepPath) =>
    Effect.gen(function* () {
      const db = yield* TypedSqliteDrizzle
      const source = yield* sqliteDbCase.getStepIdByPath(sourceStepPath)
      const target = yield* sqliteDbCase.getStepIdByPath(targetStepPath)
      const rows = yield* db
        .select({ id: sqliteSchema.flow.id })
        .from(sqliteSchema.flow)
        .where(
          and(
            eq(sqliteSchema.flow.sourceStepId, source),
            eq(sqliteSchema.flow.targetStepId, target),
          ),
        )
        .limit(1)
      return rows[0]?.id ?? (yield* Effect.dieMessage("Missing flow"))
    }),
  getProcessStatesByProcessId: (processId) =>
    Effect.gen(function* () {
      const db = yield* TypedSqliteDrizzle
      const rows = yield* db
        .select({
          id: sqliteSchema.processState.id,
          state: sqliteSchema.processState.state,
          startedByExternalParticipantId:
            sqliteSchema.processState.startedByExternalParticipantId,
        })
        .from(sqliteSchema.processState)
        .where(eq(sqliteSchema.processState.processId, processId))
      return yield* Effect.forEach(rows, toStoredProcessState)
    }),
  getProcessStateByExecutionId: (executionId) =>
    Effect.gen(function* () {
      const db = yield* TypedSqliteDrizzle
      const rows = yield* db
        .select({
          id: sqliteSchema.processState.id,
          state: sqliteSchema.processState.state,
          startedByExternalParticipantId:
            sqliteSchema.processState.startedByExternalParticipantId,
        })
        .from(sqliteSchema.processExecution)
        .innerJoin(
          sqliteSchema.processState,
          eq(
            sqliteSchema.processExecution.processStateId,
            sqliteSchema.processState.id,
          ),
        )
        .where(eq(sqliteSchema.processExecution.id, executionId))
        .limit(1)
      const row = rows[0]
      return row ? yield* toStoredProcessState(row) : null
    }),
  getScheduledFlowIdsForExecution: (executionId) =>
    Effect.gen(function* () {
      const db = yield* TypedSqliteDrizzle
      const rows = yield* db
        .select({ id: sqliteSchema.scheduledFlow.id })
        .from(sqliteSchema.scheduledFlow)
        .where(eq(sqliteSchema.scheduledFlow.processExecutionId, executionId))
      return rows.map((row) => row.id)
    }),
  getExternalParticipantIdsByEmail: (email) =>
    Effect.gen(function* () {
      const db = yield* TypedSqliteDrizzle
      const rows = yield* db
        .select({ id: sqliteSchema.externalParticipant.id })
        .from(sqliteSchema.externalParticipant)
        .where(eq(sqliteSchema.externalParticipant.email, email))
      return rows.map((row) => row.id)
    }),
  getTodoById: (todoId) =>
    Effect.gen(function* () {
      const db = yield* TypedSqliteDrizzle
      const rows = yield* db
        .select({
          id: sqliteSchema.toDo.id,
          deleted: sqliteSchema.toDo._deleted,
          completedByExternalParticipantId:
            sqliteSchema.toDo.completedByExternalParticipantId,
          completedByRoleId: sqliteSchema.toDo.completedByRoleId,
          correctionRequiredAt: sqliteSchema.toDo.correctionRequiredAt,
          failureReason: sqliteSchema.toDo.failureReason,
        })
        .from(sqliteSchema.toDo)
        .where(eq(sqliteSchema.toDo.id, todoId))
        .limit(1)
      return rows[0] ?? null
    }),
  getPublicCompletionInvitationAttemptsByTodoId: (todoId) =>
    Effect.gen(function* () {
      const db = yield* TypedSqliteDrizzle
      return yield* db
        .select({
          id: sqliteSchema.publicCompletionInvitationAttempt.id,
          email: sqliteSchema.publicCompletionInvitationAttempt.email,
          providerMessageId:
            sqliteSchema.publicCompletionInvitationAttempt.providerMessageId,
          providerSentTo:
            sqliteSchema.publicCompletionInvitationAttempt.providerSentTo,
          deliveryStatus:
            sqliteSchema.publicCompletionInvitationAttempt.deliveryStatus,
          deliveryEventId:
            sqliteSchema.publicCompletionInvitationAttempt.deliveryEventId,
          deliveryFailureKind:
            sqliteSchema.publicCompletionInvitationAttempt.deliveryFailureKind,
          deliveryFailureReason:
            sqliteSchema.publicCompletionInvitationAttempt
              .deliveryFailureReason,
        })
        .from(sqliteSchema.publicCompletionInvitationAttempt)
        .where(
          eq(sqliteSchema.publicCompletionInvitationAttempt.toDoId, todoId),
        )
    }),
  getProcessExecutionStatus: (executionId) =>
    Effect.gen(function* () {
      const db = yield* TypedSqliteDrizzle
      const rows = yield* db
        .select({
          finishedAt: sqliteSchema.processExecution.finishedAt,
          abandonedAt: sqliteSchema.processExecution.abandonedAt,
        })
        .from(sqliteSchema.processExecution)
        .where(eq(sqliteSchema.processExecution.id, executionId))
        .limit(1)
      return rows[0] ?? null
    }),
  getRoleIdByPath: (path) =>
    Effect.gen(function* () {
      const db = yield* TypedSqliteDrizzle
      const rows = yield* db
        .select({ id: sqliteSchema.role.id })
        .from(sqliteSchema.role)
        .where(eq(sqliteSchema.role.path, path))
        .limit(1)
      return rows[0]?.id ?? null
    }),
  getProcessStateStartedByRole: (executionId) =>
    Effect.gen(function* () {
      const db = yield* TypedSqliteDrizzle
      const rows = yield* db
        .select({
          startedByRoleId: sqliteSchema.processState.startedByRoleId,
        })
        .from(sqliteSchema.processState)
        .innerJoin(
          sqliteSchema.processExecution,
          eq(
            sqliteSchema.processState.id,
            sqliteSchema.processExecution.processStateId,
          ),
        )
        .where(eq(sqliteSchema.processExecution.id, executionId))
        .limit(1)
      return rows[0]?.startedByRoleId ?? null
    }),
  getFirstScheduledFlowForExecution: (executionId) =>
    Effect.gen(function* () {
      const db = yield* TypedSqliteDrizzle
      const rows = yield* db
        .select({
          completedByRoleId: sqliteSchema.scheduledFlow.completedByRoleId,
        })
        .from(sqliteSchema.scheduledFlow)
        .where(eq(sqliteSchema.scheduledFlow.processExecutionId, executionId))
        .limit(1)
      return rows[0] ?? null
    }),
}

export const postgresDbCase: GraphqlDbCase<PostgresRequirements> = {
  name: "postgres",
  layer: PostgresLayer,
  storeOrganisation,
  ensureProviderUser: ensurePostgresProviderUser,
  getProcessIdByPath: (path) =>
    Effect.gen(function* () {
      const db = yield* TypedPostgresDrizzle
      const rows = yield* db
        .select({ id: postgresSchema.process.id })
        .from(postgresSchema.process)
        .where(eq(postgresSchema.process.path, path))
        .limit(1)
      return (
        rows[0]?.id ?? (yield* Effect.dieMessage(`Missing process ${path}`))
      )
    }),
  getStepIdByPath: (path) =>
    Effect.gen(function* () {
      const db = yield* TypedPostgresDrizzle
      const rows = yield* db
        .select({ id: postgresSchema.step.id })
        .from(postgresSchema.step)
        .where(eq(postgresSchema.step.path, path))
        .limit(1)
      return rows[0]?.id ?? (yield* Effect.dieMessage(`Missing step ${path}`))
    }),
  getFlowIdByStepPaths: (sourceStepPath, targetStepPath) =>
    Effect.gen(function* () {
      const db = yield* TypedPostgresDrizzle
      const source = yield* postgresDbCase.getStepIdByPath(sourceStepPath)
      const target = yield* postgresDbCase.getStepIdByPath(targetStepPath)
      const rows = yield* db
        .select({ id: postgresSchema.flow.id })
        .from(postgresSchema.flow)
        .where(
          and(
            eq(postgresSchema.flow.sourceStepId, source),
            eq(postgresSchema.flow.targetStepId, target),
          ),
        )
        .limit(1)
      return rows[0]?.id ?? (yield* Effect.dieMessage("Missing flow"))
    }),
  getProcessStatesByProcessId: (processId) =>
    Effect.gen(function* () {
      const db = yield* TypedPostgresDrizzle
      const rows = yield* db
        .select({
          id: postgresSchema.processState.id,
          state: postgresSchema.processState.state,
          startedByExternalParticipantId:
            postgresSchema.processState.startedByExternalParticipantId,
        })
        .from(postgresSchema.processState)
        .where(eq(postgresSchema.processState.processId, processId))
      return yield* Effect.forEach(rows, toStoredProcessState)
    }),
  getProcessStateByExecutionId: (executionId) =>
    Effect.gen(function* () {
      const db = yield* TypedPostgresDrizzle
      const rows = yield* db
        .select({
          id: postgresSchema.processState.id,
          state: postgresSchema.processState.state,
          startedByExternalParticipantId:
            postgresSchema.processState.startedByExternalParticipantId,
        })
        .from(postgresSchema.processExecution)
        .innerJoin(
          postgresSchema.processState,
          eq(
            postgresSchema.processExecution.processStateId,
            postgresSchema.processState.id,
          ),
        )
        .where(eq(postgresSchema.processExecution.id, executionId))
        .limit(1)
      const row = rows[0]
      return row ? yield* toStoredProcessState(row) : null
    }),
  getScheduledFlowIdsForExecution: (executionId) =>
    Effect.gen(function* () {
      const db = yield* TypedPostgresDrizzle
      const rows = yield* db
        .select({ id: postgresSchema.scheduledFlow.id })
        .from(postgresSchema.scheduledFlow)
        .where(eq(postgresSchema.scheduledFlow.processExecutionId, executionId))
      return rows.map((row) => row.id)
    }),
  getExternalParticipantIdsByEmail: (email) =>
    Effect.gen(function* () {
      const db = yield* TypedPostgresDrizzle
      const rows = yield* db
        .select({ id: postgresSchema.externalParticipant.id })
        .from(postgresSchema.externalParticipant)
        .where(eq(postgresSchema.externalParticipant.email, email))
      return rows.map((row) => row.id)
    }),
  getTodoById: (todoId) =>
    Effect.gen(function* () {
      const db = yield* TypedPostgresDrizzle
      const rows = yield* db
        .select({
          id: postgresSchema.toDo.id,
          deleted: postgresSchema.toDo._deleted,
          completedByExternalParticipantId:
            postgresSchema.toDo.completedByExternalParticipantId,
          completedByRoleId: postgresSchema.toDo.completedByRoleId,
          correctionRequiredAt: postgresSchema.toDo.correctionRequiredAt,
          failureReason: postgresSchema.toDo.failureReason,
        })
        .from(postgresSchema.toDo)
        .where(eq(postgresSchema.toDo.id, todoId))
        .limit(1)
      return rows[0] ?? null
    }),
  getPublicCompletionInvitationAttemptsByTodoId: (todoId) =>
    Effect.gen(function* () {
      const db = yield* TypedPostgresDrizzle
      return yield* db
        .select({
          id: postgresSchema.publicCompletionInvitationAttempt.id,
          email: postgresSchema.publicCompletionInvitationAttempt.email,
          providerMessageId:
            postgresSchema.publicCompletionInvitationAttempt.providerMessageId,
          providerSentTo:
            postgresSchema.publicCompletionInvitationAttempt.providerSentTo,
          deliveryStatus:
            postgresSchema.publicCompletionInvitationAttempt.deliveryStatus,
          deliveryEventId:
            postgresSchema.publicCompletionInvitationAttempt.deliveryEventId,
          deliveryFailureKind:
            postgresSchema.publicCompletionInvitationAttempt
              .deliveryFailureKind,
          deliveryFailureReason:
            postgresSchema.publicCompletionInvitationAttempt
              .deliveryFailureReason,
        })
        .from(postgresSchema.publicCompletionInvitationAttempt)
        .where(
          eq(postgresSchema.publicCompletionInvitationAttempt.toDoId, todoId),
        )
    }),
  getProcessExecutionStatus: (executionId) =>
    Effect.gen(function* () {
      const db = yield* TypedPostgresDrizzle
      const rows = yield* db
        .select({
          finishedAt: postgresSchema.processExecution.finishedAt,
          abandonedAt: postgresSchema.processExecution.abandonedAt,
        })
        .from(postgresSchema.processExecution)
        .where(eq(postgresSchema.processExecution.id, executionId))
        .limit(1)
      return rows[0] ?? null
    }),
  getRoleIdByPath: (path) =>
    Effect.gen(function* () {
      const db = yield* TypedPostgresDrizzle
      const rows = yield* db
        .select({ id: postgresSchema.role.id })
        .from(postgresSchema.role)
        .where(eq(postgresSchema.role.path, path))
        .limit(1)
      return rows[0]?.id ?? null
    }),
  getProcessStateStartedByRole: (executionId) =>
    Effect.gen(function* () {
      const db = yield* TypedPostgresDrizzle
      const rows = yield* db
        .select({
          startedByRoleId: postgresSchema.processState.startedByRoleId,
        })
        .from(postgresSchema.processState)
        .innerJoin(
          postgresSchema.processExecution,
          eq(
            postgresSchema.processState.id,
            postgresSchema.processExecution.processStateId,
          ),
        )
        .where(eq(postgresSchema.processExecution.id, executionId))
        .limit(1)
      return rows[0]?.startedByRoleId ?? null
    }),
  getFirstScheduledFlowForExecution: (executionId) =>
    Effect.gen(function* () {
      const db = yield* TypedPostgresDrizzle
      const rows = yield* db
        .select({
          completedByRoleId: postgresSchema.scheduledFlow.completedByRoleId,
        })
        .from(postgresSchema.scheduledFlow)
        .where(eq(postgresSchema.scheduledFlow.processExecutionId, executionId))
        .limit(1)
      return rows[0] ?? null
    }),
}
