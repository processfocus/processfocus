import {
  and,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm"
import { Effect, Layer } from "effect"
import * as schema from "@pf/drizzle-postgres"
import {
  type PullCheckpoint,
  type TodoPullMode,
  TodoQueries,
  type TodoRow,
  calculateFormComplexity,
} from "@pf/graphql-db-operations"
import { TypedPostgresDrizzle } from "@pf/service-drizzle-postgres"

const todoUpdatedAtMillis = sql<number>`CAST(EXTRACT(EPOCH FROM ${schema.toDo.updatedAt}) * 1000 AS DOUBLE PRECISION)`

/**
 * Build the base todo query with SELECT + FROM + JOINs.
 * Callers add WHERE/ORDER BY/LIMIT as needed.
 */
const buildTodoBaseQuery = (db: TypedPostgresDrizzle["Type"]) =>
  db
    .select({
      id: schema.toDo.id,
      processExecutionId: schema.toDo.processExecutionId,
      flowId: schema.toDo.flowId,
      processName: schema.process.name,
      processPath: schema.process.path,
      processOrgUnitPath: schema.orgUnit.path,
      stepName: schema.step.name,
      stepPath: schema.step.path,
      rolePath: schema.role.path,
      assignedToProviderUserId: schema.toDo.assignedToProviderUserId,
      assignedToProviderUserEmail: schema.providerUser.email,
      role: schema.role.name,
      description: schema.step.purpose,
      formFields: schema.step.formFields,
      correctionRequiredAt: schema.toDo.correctionRequiredAt,
      updatedAt: todoUpdatedAtMillis.as("updated_at_millis"),
      createdAt:
        sql<string>`TO_CHAR(${schema.toDo.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.FF3"Z"')`.as(
          "created_at_iso",
        ),
      // Pre-calculated SLA target and warning times (TO_CHAR returns NULL for NULL input)
      slaTargetAt: sql<
        string | null
      >`TO_CHAR(${schema.toDo.slaTargetAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.FF3"Z"')`.as(
        "sla_target_at_iso",
      ),
      slaWarningAt: sql<
        string | null
      >`TO_CHAR(${schema.toDo.slaWarningAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.FF3"Z"')`.as(
        "sla_warning_at_iso",
      ),
      deleted: schema.toDo._deleted,
    })
    .from(schema.toDo)
    .innerJoin(
      schema.processExecution,
      eq(schema.toDo.processExecutionId, schema.processExecution.id),
    )
    .innerJoin(
      schema.processState,
      eq(schema.processExecution.processStateId, schema.processState.id),
    )
    .innerJoin(
      schema.process,
      eq(schema.processState.processId, schema.process.id),
    )
    .innerJoin(schema.orgUnit, eq(schema.process.orgUnitId, schema.orgUnit.id))
    .innerJoin(schema.flow, eq(schema.toDo.flowId, schema.flow.id))
    .innerJoin(schema.step, eq(schema.flow.targetStepId, schema.step.id))
    .innerJoin(schema.role, eq(schema.step.roleId, schema.role.id))
    .leftJoin(
      schema.providerUser,
      eq(schema.toDo.assignedToProviderUserId, schema.providerUser.id),
    )

type TodoQueryRow = Awaited<ReturnType<typeof buildTodoBaseQuery>>[number]

/**
 * Map a raw query row to TodoRow shape.
 */
const mapRowToTodo = (row: TodoQueryRow): TodoRow => ({
  id: row.id,
  processExecutionId: row.processExecutionId,
  flowId: row.flowId,
  processName: row.processName,
  processPath: row.processPath,
  processOrgUnitPath: row.processOrgUnitPath,
  stepName: row.stepName,
  stepPath: row.stepPath,
  rolePath: row.rolePath,
  assignedToProviderUserId: row.assignedToProviderUserId,
  assignedToProviderUserEmail: row.assignedToProviderUserEmail,
  role: row.role,
  description: row.description,
  status: row.correctionRequiredAt
    ? "Correction Required"
    : row.deleted
      ? "Completed"
      : "Active",
  priority: "Medium", // Phase 1: default value
  assignedAt: row.createdAt, // Now ISO string
  dueAt: row.slaTargetAt, // Pre-calculated from SLA at todo creation
  dueWarningAt: row.slaWarningAt, // Pre-calculated from SLA at todo creation
  formComplexity: calculateFormComplexity(row.formFields),
  updatedAt: row.updatedAt,
  deleted: row.deleted,
  summary: [], // Computed in pullTodo resolver
})

/**
 * Live implementation of TodoQueries service for Postgres.
 * Provides pull operations for RxDB replication.
 */
export const PostgresTodoQueriesLive = Layer.effect(
  TodoQueries,
  Effect.gen(function* () {
    const db = yield* TypedPostgresDrizzle

    return {
      pullTodo: (
        checkpoint: PullCheckpoint | null | undefined,
        limit: number,
        mode: TodoPullMode,
      ) =>
        Effect.gen(function* () {
          if (mode.kind === "live-backfill" && mode.head === null) {
            return []
          }

          const conditions = []
          const isLiveBackfill = mode.kind === "live-backfill"

          if (isLiveBackfill) {
            conditions.push(eq(schema.toDo._deleted, false))
          }

          if (mode.kind === "live-backfill" && mode.head) {
            const headTimestamp = sql`TO_TIMESTAMP(${mode.head.updatedAt} / 1000.0)`
            const headFilter = or(
              lt(schema.toDo.updatedAt, headTimestamp),
              and(
                eq(schema.toDo.updatedAt, headTimestamp),
                lte(schema.toDo.id, mode.head.id),
              ),
            )
            if (headFilter) {
              conditions.push(headFilter)
            }
          }

          if (checkpoint) {
            // Convert checkpoint updatedAt from epoch millis to timestamp for comparison
            const checkpointTimestamp = sql`TO_TIMESTAMP(${checkpoint.updatedAt} / 1000.0)`

            // Checkpoint filtering: (updatedAt > checkpoint) OR (updatedAt = checkpoint AND id > checkpoint.id)
            const checkpointFilter = or(
              gt(schema.toDo.updatedAt, checkpointTimestamp),
              and(
                eq(schema.toDo.updatedAt, checkpointTimestamp),
                gt(schema.toDo.id, checkpoint.id),
              ),
            )
            if (checkpointFilter) {
              conditions.push(checkpointFilter)
            }
          }

          const rows = yield* buildTodoBaseQuery(db)
            .where(conditions.length > 0 ? and(...conditions) : undefined)
            .orderBy(todoUpdatedAtMillis, schema.toDo.id)
            .limit(limit)

          return rows.map(mapRowToTodo)
        }),

      getTodoReplicationHead: () =>
        Effect.gen(function* () {
          const rows = yield* db
            .select({
              id: schema.toDo.id,
              updatedAt: todoUpdatedAtMillis,
            })
            .from(schema.toDo)
            .orderBy(desc(todoUpdatedAtMillis), desc(schema.toDo.id))
            .limit(1)

          return rows[0] ?? null
        }),

      getTodos: (ids: readonly string[]) =>
        Effect.gen(function* () {
          if (ids.length === 0) {
            return []
          }

          const rows = yield* buildTodoBaseQuery(db)
            .where(inArray(schema.toDo.id, ids))
            .orderBy(schema.toDo.updatedAt, schema.toDo.id)

          return rows.map(mapRowToTodo)
        }),

      listTodos: (query) =>
        Effect.gen(function* () {
          const conditions = []
          if (query.processPath != null) {
            conditions.push(eq(schema.process.path, query.processPath))
          }
          if (query.state) {
            switch (query.state.kind) {
              case "correction-required":
                conditions.push(isNotNull(schema.toDo.correctionRequiredAt))
                break
              case "correction-free":
                conditions.push(
                  isNull(schema.toDo.correctionRequiredAt),
                  eq(schema.toDo._deleted, query.state.deleted),
                )
                break
            }
          }

          const rows = yield* buildTodoBaseQuery(db)
            .where(conditions.length > 0 ? and(...conditions) : undefined)
            .orderBy(desc(schema.toDo.createdAt), schema.toDo.id)
            .limit(query.limit)
            .offset(query.offset)

          return rows.map(mapRowToTodo)
        }),
    }
  }),
)
