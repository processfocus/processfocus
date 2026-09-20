import type { SqlError } from "@effect/sql/SqlError"
import {
  type SQL,
  and,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"
import { Effect, Layer } from "effect"
import * as schema from "@pf/drizzle-postgres"
import {
  ExecutionQueries,
  type ExecutionRow,
  type PullCheckpoint,
  type TodoStepRow,
} from "@pf/graphql-db-operations"
import { TypedPostgresDrizzle } from "@pf/service-drizzle-postgres"

/**
 * Live implementation of ExecutionQueries service for Postgres.
 * Provides pull operations for RxDB replication.
 */
export const PostgresExecutionQueriesLive = Layer.effect(
  ExecutionQueries,
  Effect.gen(function* () {
    const db = yield* TypedPostgresDrizzle

    // Alias for role's org unit (separate from provider user's org unit)
    const roleOrgUnit = alias(schema.orgUnit, "role_org_unit")
    const completingRole = alias(schema.role, "completing_role")
    const assignedProviderUser = alias(
      schema.providerUser,
      "assigned_provider_user",
    )

    /**
     * Query todos with step info for a batch of execution IDs.
     * Simple join: todo -> flow -> step, with optional provider user info.
     */
    const queryTodosForExecutions = (
      executionIds: string[],
    ): Effect.Effect<TodoStepRow[], SqlError> =>
      Effect.gen(function* () {
        if (executionIds.length === 0) return []

        const rows = yield* db
          .select({
            executionId: schema.toDo.processExecutionId,
            todoId: schema.toDo.id,
            stepId: schema.step.id,
            stepName: schema.step.name,
            stepPath: schema.step.path,
            completed: schema.toDo._deleted,
            failureReason: schema.toDo.failureReason,
            correctionRequiredAt: sql<
              number | null
            >`CASE WHEN ${schema.toDo.correctionRequiredAt} IS NULL THEN NULL ELSE EXTRACT(EPOCH FROM ${schema.toDo.correctionRequiredAt}) * 1000 END`.as(
              "correction_required_at_millis",
            ),
            correctionFailureReason: schema.toDo.correctionFailureReason,
            completedByUserId: schema.toDo.completedByUserId,
            providerUserId: schema.providerUser.id,
            providerUserFirstName: schema.providerUser.firstName,
            providerUserLastName: schema.providerUser.lastName,
            providerUserEmail: schema.providerUser.email,
            providerUserPicture: schema.providerUser.picture,
            providerUserOrgUnit: schema.orgUnit.name,
            assignedProviderUserEmail: assignedProviderUser.email,
            externalParticipantId: schema.externalParticipant.id,
            externalParticipantEmail: schema.externalParticipant.email,
            roleId: schema.role.id,
            roleName: schema.role.name,
            roleOrgUnitPath: roleOrgUnit.path,
            completingRoleId: completingRole.id,
            completingRoleName: completingRole.name,
            completingRolePath: completingRole.path,
            itemData: schema.toDo.itemData,
            createdAt:
              sql<number>`EXTRACT(EPOCH FROM ${schema.toDo.createdAt}) * 1000`.as(
                "created_at_millis",
              ),
            updatedAt:
              sql<number>`EXTRACT(EPOCH FROM ${schema.toDo.updatedAt}) * 1000`.as(
                "updated_at_millis",
              ),
          })
          .from(schema.toDo)
          .innerJoin(schema.flow, eq(schema.toDo.flowId, schema.flow.id))
          .innerJoin(schema.step, eq(schema.flow.targetStepId, schema.step.id))
          .leftJoin(schema.role, eq(schema.step.roleId, schema.role.id))
          .leftJoin(roleOrgUnit, eq(schema.role.orgUnitId, roleOrgUnit.id))
          .leftJoin(
            completingRole,
            eq(schema.toDo.completedByRoleId, completingRole.id),
          )
          .leftJoin(
            schema.user,
            eq(schema.toDo.completedByUserId, schema.user.id),
          )
          .leftJoin(
            schema.providerUser,
            and(
              eq(schema.user.id, schema.providerUser.userId),
              eq(schema.providerUser._deleted, false),
            ),
          )
          .leftJoin(
            schema.orgUnit,
            eq(schema.providerUser.orgUnitId, schema.orgUnit.id),
          )
          .leftJoin(
            assignedProviderUser,
            eq(schema.toDo.assignedToProviderUserId, assignedProviderUser.id),
          )
          .leftJoin(
            schema.externalParticipant,
            eq(
              schema.toDo.completedByExternalParticipantId,
              schema.externalParticipant.id,
            ),
          )
          .where(inArray(schema.toDo.processExecutionId, executionIds))
          .orderBy(schema.toDo.updatedAt)

        return rows.map((row) => ({
          executionId: row.executionId,
          todoId: row.todoId,
          stepId: row.stepId,
          stepName: row.stepName,
          stepPath: row.stepPath,
          completed: row.completed,
          failureReason: row.failureReason,
          correctionRequiredAt: row.correctionRequiredAt,
          correctionFailureReason: row.correctionFailureReason,
          completedByUserId: row.completedByUserId,
          providerUserId: row.providerUserId,
          providerUserFirstName: row.providerUserFirstName,
          providerUserLastName: row.providerUserLastName,
          providerUserEmail: row.providerUserEmail,
          providerUserPicture: row.providerUserPicture,
          providerUserOrgUnit: row.providerUserOrgUnit,
          assignedProviderUserEmail: row.assignedProviderUserEmail,
          externalParticipantId: row.externalParticipantId,
          externalParticipantEmail: row.externalParticipantEmail,
          roleId: row.roleId,
          roleName: row.roleName,
          roleOrgUnitPath: row.roleOrgUnitPath,
          completingRoleId: row.completingRoleId,
          completingRoleName: row.completingRoleName,
          completingRolePath: row.completingRolePath,
          itemData: row.itemData as Record<string, unknown> | unknown[] | null,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        }))
      })

    // Aliases for start step and its role (to avoid conflict with todo query's step/role)
    const startStep = alias(schema.step, "start_step")
    const startStepRole = alias(schema.role, "start_step_role")
    const startStepRoleOrgUnit = alias(
      schema.orgUnit,
      "start_step_role_org_unit",
    )
    const startedByRole = alias(schema.role, "started_by_role")
    const startExternalParticipant = alias(
      schema.externalParticipant,
      "start_external_participant",
    )

    /**
     * Builds and executes the execution query.
     * @param whereClause - The WHERE clause to apply (checkpoint filter or id filter)
     * @param limit - Optional limit for the query
     */
    const queryExecutions = (options: {
      readonly whereClause: SQL | undefined
      readonly limit?: number | undefined
      readonly offset?: number | undefined
      readonly newestFirst?: boolean | undefined
    }): Effect.Effect<ExecutionRow[], SqlError> =>
      Effect.gen(function* () {
        // CTE for duration stats - uses stored business_duration from completed executions
        // business_duration is calculated and stored when execution completes
        const durationStats = db.$with("duration_stats").as(
          db
            .select({
              processId: schema.processState.processId,
              minDurationMs:
                sql<number>`MIN(${schema.processExecution.businessDuration})`.as(
                  "min_duration_ms",
                ),
              maxDurationMs:
                sql<number>`MAX(${schema.processExecution.businessDuration})`.as(
                  "max_duration_ms",
                ),
            })
            .from(schema.processExecution)
            .innerJoin(
              schema.processState,
              eq(
                schema.processExecution.processStateId,
                schema.processState.id,
              ),
            )
            .where(
              and(
                isNotNull(schema.processExecution.finishedAt),
                isNotNull(schema.processExecution.businessDuration),
                eq(schema.processExecution._deleted, false),
                eq(schema.processState._deleted, false),
              ),
            )
            .groupBy(schema.processState.processId),
        )

        // Main query: join process_execution -> process_state -> process -> start_step
        // Also join to started_by_user -> providerUser for who started the process
        // Use TO_CHAR for ISO 8601 format output
        const baseQuery = db
          .with(durationStats)
          .select({
            id: schema.processExecution.id,
            processStateId: schema.processExecution.processStateId,
            withoutWaiting: schema.processExecution.withoutWaiting,
            processName: schema.process.name,
            processPath: schema.process.path,
            finishedAt: sql<
              string | null
            >`CASE WHEN ${schema.processExecution.finishedAt} IS NULL THEN NULL ELSE TO_CHAR(${schema.processExecution.finishedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') END`.as(
              "finished_at_iso",
            ),
            abandonedAt: sql<
              string | null
            >`CASE WHEN ${schema.processExecution.abandonedAt} IS NULL THEN NULL ELSE TO_CHAR(${schema.processExecution.abandonedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') END`.as(
              "abandoned_at_iso",
            ),
            abandonedReason: schema.processExecution.abandonedReason,
            startedAt:
              sql<string>`TO_CHAR(${schema.processExecution.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`.as(
                "started_at_iso",
              ),
            updatedAt:
              sql<number>`EXTRACT(EPOCH FROM ${schema.processExecution.updatedAt}) * 1000`.as(
                "updated_at_millis",
              ),
            deleted: schema.processExecution._deleted,
            // For durationMs calculation
            startedAtMs:
              sql<number>`EXTRACT(EPOCH FROM ${schema.processExecution.createdAt}) * 1000`.as(
                "started_at_millis",
              ),
            finishedAtMs: sql<
              number | null
            >`CASE WHEN ${schema.processExecution.finishedAt} IS NULL THEN NULL ELSE EXTRACT(EPOCH FROM ${schema.processExecution.finishedAt}) * 1000 END`.as(
              "finished_at_millis",
            ),
            // Start step info
            startStepId: startStep.id,
            startStepName: startStep.name,
            startStepPath: startStep.path,
            startStepRoleId: startStepRole.id,
            startStepRoleName: startStepRole.name,
            startStepRoleOrgUnitPath: startStepRoleOrgUnit.path,
            startedByRoleId: startedByRole.id,
            startedByRoleName: startedByRole.name,
            startedByRolePath: startedByRole.path,
            startStepEmbedded: startStep.embedded,
            startStepExternalParticipantId: startExternalParticipant.id,
            startStepExternalParticipantEmail: startExternalParticipant.email,
            // Process state created_at = when start step started
            processStateCreatedAt:
              sql<string>`TO_CHAR(${schema.processState.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`.as(
                "process_state_created_at_iso",
              ),
            // Started by provider user info
            startedByEmail: schema.providerUser.email,
            startedById: schema.providerUser.id,
            startedByFirstName: schema.providerUser.firstName,
            startedByLastName: schema.providerUser.lastName,
            startedByPicture: schema.providerUser.picture,
            startedByOrgUnit: schema.orgUnit.name,
            // SLA info from process
            processSlaValue: schema.process.slaValue,
            processSlaUnit: schema.process.slaUnit,
            processSlaWarning: schema.process.slaWarning,
            // Duration stats from CTE
            typicalDurationMinMs: durationStats.minDurationMs,
            typicalDurationMaxMs: durationStats.maxDurationMs,
            // Process org unit for SLA calculation
            processOrgUnitId: schema.process.orgUnitId,
          })
          .from(schema.processExecution)
          .innerJoin(
            schema.processState,
            eq(schema.processExecution.processStateId, schema.processState.id),
          )
          .innerJoin(
            schema.process,
            eq(schema.processState.processId, schema.process.id),
          )
          .innerJoin(
            startStep,
            eq(schema.processState.startStepId, startStep.id),
          )
          .leftJoin(startStepRole, eq(startStep.roleId, startStepRole.id))
          .leftJoin(
            startStepRoleOrgUnit,
            eq(startStepRole.orgUnitId, startStepRoleOrgUnit.id),
          )
          .leftJoin(
            startedByRole,
            eq(schema.processState.startedByRoleId, startedByRole.id),
          )
          .leftJoin(
            schema.user,
            eq(schema.processState.startedByUserId, schema.user.id),
          )
          .leftJoin(
            schema.providerUser,
            and(
              eq(schema.user.id, schema.providerUser.userId),
              eq(schema.providerUser._deleted, false),
            ),
          )
          .leftJoin(
            schema.orgUnit,
            eq(schema.providerUser.orgUnitId, schema.orgUnit.id),
          )
          .leftJoin(
            startExternalParticipant,
            eq(
              schema.processState.startedByExternalParticipantId,
              startExternalParticipant.id,
            ),
          )
          .leftJoin(
            durationStats,
            eq(schema.processState.processId, durationStats.processId),
          )
          .where(options.whereClause)

        const orderedQuery = options.newestFirst
          ? baseQuery.orderBy(
              desc(schema.processExecution.createdAt),
              schema.processExecution.id,
            )
          : baseQuery.orderBy(
              schema.processExecution.updatedAt,
              schema.processExecution.id,
            )

        const limitedQuery =
          options.limit !== undefined
            ? orderedQuery.limit(options.limit)
            : orderedQuery
        const query =
          options.offset !== undefined
            ? limitedQuery.offset(options.offset)
            : limitedQuery
        const rows = yield* query

        // Map to ExecutionRow shape
        return rows.map(
          (row): ExecutionRow => ({
            id: row.id,
            processStateId: row.processStateId,
            withoutWaiting: row.withoutWaiting,
            processName: row.processName,
            processPath: row.processPath,
            // abandonedAt wins: abandonedReason with no abandonedAt is how
            // system-start failures are represented until the schema grows a
            // dedicated execution-level failure field.
            status:
              row.abandonedAt != null
                ? "Abandoned"
                : row.abandonedReason != null
                  ? "Failed"
                  : row.finishedAt != null
                    ? "Completed"
                    : "Running",
            startedAt: row.startedAt,
            finishedAt: row.finishedAt,
            durationMs:
              row.finishedAtMs != null
                ? Math.round(row.finishedAtMs - row.startedAtMs)
                : null,
            updatedAt: row.updatedAt,
            deleted: row.deleted,
            startStepId: row.startStepId,
            startStepName: row.startStepName,
            startStepPath: row.startStepPath,
            startStepRoleId: row.startStepRoleId,
            startStepRoleName: row.startStepRoleName,
            startStepRoleOrgUnitPath: row.startStepRoleOrgUnitPath,
            startedByRoleId: row.startedByRoleId,
            startedByRoleName: row.startedByRoleName,
            startedByRolePath: row.startedByRolePath,
            startStepEmbedded: row.startStepEmbedded,
            startStepExternalParticipantId: row.startStepExternalParticipantId,
            startStepExternalParticipantEmail:
              row.startStepExternalParticipantEmail,
            processStateCreatedAt: row.processStateCreatedAt,
            startedByEmail: row.startedByEmail,
            startedById: row.startedById,
            startedByFirstName: row.startedByFirstName,
            startedByLastName: row.startedByLastName,
            startedByPicture: row.startedByPicture,
            startedByOrgUnit: row.startedByOrgUnit,
            processSlaValue: row.processSlaValue,
            processSlaUnit: row.processSlaUnit,
            processSlaWarning: row.processSlaWarning,
            typicalDurationMinMs: row.typicalDurationMinMs,
            typicalDurationMaxMs: row.typicalDurationMaxMs,
            processOrgUnitId: row.processOrgUnitId,
            abandonedReason: row.abandonedReason,
          }),
        )
      })

    /**
     * Builds checkpoint filter for pull replication.
     * Filters: (updatedAt > checkpoint) OR (updatedAt = checkpoint AND id > checkpoint.id)
     */
    const buildCheckpointFilter = (
      checkpoint: PullCheckpoint | null | undefined,
    ): SQL | undefined => {
      if (!checkpoint) return undefined

      // Convert checkpoint updatedAt from epoch millis to timestamp for comparison
      const checkpointTimestamp = sql`TO_TIMESTAMP(${checkpoint.updatedAt} / 1000.0)`

      return or(
        gt(schema.processExecution.updatedAt, checkpointTimestamp),
        and(
          eq(schema.processExecution.updatedAt, checkpointTimestamp),
          gt(schema.processExecution.id, checkpoint.id),
        ),
      )
    }

    /**
     * Get the process state JSON for an execution.
     * Joins process_execution to process_state and returns the state data.
     */
    const getProcessStateByExecutionId = (
      executionId: string,
    ): Effect.Effect<Record<string, unknown> | null, SqlError> =>
      Effect.gen(function* () {
        const rows = yield* db
          .select({
            state: schema.processState.state,
          })
          .from(schema.processExecution)
          .innerJoin(
            schema.processState,
            eq(schema.processExecution.processStateId, schema.processState.id),
          )
          .where(eq(schema.processExecution.id, executionId))
          .limit(1)

        const row = rows[0]
        if (!row) return null
        return row.state as Record<string, unknown>
      })

    const runningFilter = and(
      isNull(schema.processExecution.finishedAt),
      isNull(schema.processExecution.abandonedAt),
      isNull(schema.processExecution.abandonedReason),
    )

    return {
      pullExecution: (
        checkpoint: PullCheckpoint | null | undefined,
        limit: number,
        includeRunning = false,
        historySince?: number,
      ) =>
        queryExecutions({
          whereClause: and(
            historySince === undefined
              ? undefined
              : or(
                  buildCheckpointFilter({ id: "", updatedAt: historySince }),
                  runningFilter,
                ),
            includeRunning && checkpoint
              ? or(buildCheckpointFilter(checkpoint), runningFilter)
              : buildCheckpointFilter(checkpoint),
          ),
          limit,
        }),

      getExecutions: (ids: string[]) =>
        ids.length === 0
          ? Effect.succeed([])
          : queryExecutions({
              whereClause: inArray(schema.processExecution.id, ids),
            }),

      listExecutions: (query) =>
        queryExecutions({
          whereClause: and(
            eq(schema.processExecution._deleted, false),
            query.processPath != null
              ? eq(schema.process.path, query.processPath)
              : undefined,
          ),
          limit: query.limit,
          offset: query.offset,
          newestFirst: true,
        }),

      getTodosForExecutions: queryTodosForExecutions,

      getProcessStateByExecutionId,
    }
  }),
)
