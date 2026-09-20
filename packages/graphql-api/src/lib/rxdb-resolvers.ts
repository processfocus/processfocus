import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { FileSystem } from "@effect/platform"
import { Effect } from "effect"
import type { GraphQLResolveInfo } from "graphql"
import { AuthorizationService } from "@pf/auth-policy"
import {
  StepRoleQueries,
  type TodoPullMode,
  TodoQueries,
} from "@pf/graphql-db-operations"
import type {
  MutationPushDraftProcessExecutionArgs,
  MutationPushTodoArgs,
  QueryPullDraftProcessExecutionArgs,
  QueryPullExecutionArgs,
  QueryPullProcessArgs,
  QueryPullTodoArgs,
  RequireFields,
} from "@pf/graphql-schema"
import { NotAuthorized, PullCheckpointMode } from "@pf/graphql-schema"
import { TodoSummaryComputation } from "@pf/todo-summary"
import {
  buildExecutionAuthorizationResource,
  buildPrincipal,
  buildStepPrincipal,
  canSkipScheduleWaits,
  checkStepAuthorization,
  filterAuthorizedExecutionRows,
  filterAuthorizedProcessRows,
  filterAuthorizedTodoRows,
  trySequentialStepAuthorization,
} from "./authorization"
import { DraftProcessEvents } from "./draft-process-events"
import { checkExecutionAbandonAuthorization } from "./execution-abandon-authorization"
import { ExecutionEvents } from "./execution-events"
import { hasPendingSystemStartRestartDispatch } from "./execution-restart"
import { ResolverRuntime } from "./graphql-api"
import { ProcessDurationService } from "./process-duration-service"
import { ProcessEvents } from "./process-events"
import {
  createResolverExecutor,
  getProcessPathFromStepPath,
} from "./resolver-utils"
import { DraftProcessExecutionCollectionOps } from "./rxdb/draft-process-execution"
import { ExecutionCollectionOps } from "./rxdb/execution"
import { ProcessCollectionOps, formatDurationRange } from "./rxdb/process"
import {
  makeAuthorizedStreamSubscription,
  makePushResolver,
} from "./rxdb/resolver-makers"
import {
  filterAuthorizedDrafts,
  filterAuthorizedExecutions,
  filterAuthorizedProcesses,
  filterAuthorizedTodos,
} from "./rxdb/subscription-filters"
import { TodoCollectionOps } from "./rxdb/todo"
import { scanAuthorizedPull, wrapAsPullBulk } from "./rxdb/utils"
import { TodoEvents } from "./todo-events"
import type { ResolverMap, UserContext } from "./types"

export const rxdbSchema = Effect.gen(function* () {
  // Load rxdb schema from the graphql-schema package using package exports
  const fs = yield* FileSystem.FileSystem
  const schemaRoot = process.env["PF_GRAPHQL_SCHEMA_ROOT"]
  const schemaPath = schemaRoot
    ? join(schemaRoot, "rxdb.graphql")
    : fileURLToPath(import.meta.resolve("@pf/graphql-schema/rxdb.graphql"))
  const rxdbTypeDefs = yield* fs.readFileString(schemaPath)

  // Close over ManagedRuntime once at this boundary for stream authorization.
  const runtime = yield* ResolverRuntime
  const { runPromise } = createResolverExecutor(runtime)

  // Create generic resolvers for DraftProcessExecution using the resolver-makers
  // Note: pullDraftProcessExecution is now implemented with authorization filtering
  // directly in the resolver below, similar to Process/Todo/Execution
  const pushDraftProcessExecution = makePushResolver(
    DraftProcessExecutionCollectionOps,
    DraftProcessEvents,
  )

  // Authorized subscription for draft process executions
  const streamDraftProcessExecution = makeAuthorizedStreamSubscription(
    DraftProcessEvents,
    "streamDraftProcessExecution",
    filterAuthorizedDrafts,
    buildPrincipal,
    runPromise,
  )

  // Note: Process pull is implemented with authorization filtering directly
  // in the resolver below, not using the generic makePullResolver

  // Note: Todo pull is also implemented with authorization filtering directly
  // in the resolver below, not using the generic makePullResolver
  const pushTodo = makePushResolver(TodoCollectionOps, undefined)

  // Authorized subscription for todos
  const streamTodo = makeAuthorizedStreamSubscription(
    TodoEvents,
    "streamTodo",
    filterAuthorizedTodos,
    buildPrincipal,
    runPromise,
  )

  // Note: Execution pull is implemented with authorization filtering directly
  // in the resolver below, not using the generic makePullResolver

  // Authorized subscription for processes
  const streamProcess = makeAuthorizedStreamSubscription(
    ProcessEvents,
    "streamProcess",
    filterAuthorizedProcesses,
    buildStepPrincipal,
    runPromise,
  )

  // Authorized subscription for executions
  const streamExecution = makeAuthorizedStreamSubscription(
    ExecutionEvents,
    "streamExecution",
    filterAuthorizedExecutions,
    buildStepPrincipal,
    runPromise,
  )

  // Note: ResolverMap typing is loose here because the generic resolver-makers
  // return Effect types that are slightly different from what GraphQL codegen expects.
  // The runtime behavior is correct - mapToGraphql ensures proper types at runtime.
  const resolvers: ResolverMap = {
    Query: {
      pullDraftProcessExecution: (
        _parent: unknown,
        args: RequireFields<QueryPullDraftProcessExecutionArgs, "limit">,
        context: UserContext,
      ) =>
        Effect.gen(function* () {
          const draftOps = yield* DraftProcessExecutionCollectionOps
          const stepRoleQueries = yield* StepRoleQueries
          const auth = yield* AuthorizationService

          const principal = yield* buildPrincipal(context)
          const authorizedRows = yield* scanAuthorizedPull({
            initialCheckpoint: args.checkpoint ?? null,
            limit: args.limit,
            pull: draftOps.pull,
            checkpointOf: (row) => ({ id: row.id, updatedAt: row.updatedAt }),
            authorizeRows: (rows) =>
              Effect.gen(function* () {
                const stepRolesMap =
                  yield* stepRoleQueries.queryRolePathsByStepPaths(
                    rows.map((row) => row.startStepPath),
                  )
                const authorized: typeof rows = []
                for (const row of rows) {
                  const stepRoleInfo = stepRolesMap.get(row.startStepPath) ?? {
                    rolePath: null,
                    supportingRolePaths: [],
                    startsProcess: true,
                    embedded: false,
                  }
                  const canDraft = yield* trySequentialStepAuthorization(
                    stepRoleInfo,
                    row.startStepPath,
                    getProcessPathFromStepPath(row.startStepPath),
                    (resource) => auth.canDraftStep(principal, resource),
                  )
                  if (canDraft) authorized.push(row)
                }
                return authorized
              }),
            idOfAuthorized: (row) => row.id,
          })

          const documents = yield* Effect.all(
            authorizedRows.map((row) => draftOps.mapToGraphql(row)),
            { concurrency: "unbounded" },
          )
          return wrapAsPullBulk(documents)
        }),
      pullProcess: (
        _parent: unknown,
        args: RequireFields<QueryPullProcessArgs, "limit">,
        context: UserContext,
      ) =>
        Effect.gen(function* () {
          const processOps = yield* ProcessCollectionOps
          const durationService = yield* ProcessDurationService

          const authorizedRows = yield* scanAuthorizedPull({
            initialCheckpoint: args.checkpoint ?? null,
            limit: args.limit,
            pull: processOps.pull,
            checkpointOf: (row) => ({ id: row.id, updatedAt: row.updatedAt }),
            authorizeRows: (rows) => filterAuthorizedProcessRows(context, rows),
            idOfAuthorized: (row) => row.id,
          })

          const businessDurations = yield* durationService.calculateDurations(
            authorizedRows.map((row) => ({
              id: row.id,
              orgUnitId: row.orgUnit.id,
            })),
          )

          const documents = yield* Effect.all(
            authorizedRows.map((row) =>
              processOps.mapToGraphql(row).pipe(
                Effect.flatMap((doc) =>
                  Effect.gen(function* () {
                    const canSkip = yield* canSkipScheduleWaits(
                      context,
                      row.path,
                    )
                    const stats = businessDurations.get(row.id)
                    if (stats) {
                      return {
                        ...doc,
                        canSkipScheduleWaits: canSkip,
                        duration: formatDurationRange(
                          stats.minBusinessDurationMs,
                          stats.maxBusinessDurationMs,
                        ),
                      }
                    }
                    return { ...doc, canSkipScheduleWaits: canSkip }
                  }),
                ),
              ),
            ),
            { concurrency: "unbounded" },
          )
          return wrapAsPullBulk(documents)
        }),
      pullTodo: (
        _parent: unknown,
        args: RequireFields<QueryPullTodoArgs, "limit">,
        context: UserContext,
      ) =>
        Effect.gen(function* () {
          const todoOps = yield* TodoCollectionOps
          const todoQueries = yield* TodoQueries
          const summaryComputation = yield* TodoSummaryComputation
          const initialCheckpoint = args.checkpoint
            ? {
                id: args.checkpoint.id,
                updatedAt: args.checkpoint.updatedAt,
              }
            : null
          const requestedMode = args.checkpoint?.mode
          const checkpointRows =
            initialCheckpoint && requestedMode == null
              ? yield* todoQueries.getTodos([initialCheckpoint.id])
              : []
          const isLiveBackfill =
            initialCheckpoint === null ||
            requestedMode === PullCheckpointMode.LiveBackfill ||
            (requestedMode == null &&
              checkpointRows.some((row) => !row.deleted))
          const requestedBackfillHead = args.checkpoint?.backfillHead
            ? {
                id: args.checkpoint.backfillHead.id,
                updatedAt: args.checkpoint.backfillHead.updatedAt,
              }
            : null
          // Freeze the initial table HEAD across every live-backfill page.
          // Later writes remain beyond that boundary for incremental pulls.
          const replicationHead = isLiveBackfill
            ? (requestedBackfillHead ??
              (yield* todoQueries.getTodoReplicationHead()))
            : null
          const pullMode: TodoPullMode = isLiveBackfill
            ? { kind: "live-backfill", head: replicationHead }
            : { kind: "incremental" }

          const authorizedRows = yield* scanAuthorizedPull({
            initialCheckpoint,
            limit: args.limit,
            pull: (checkpoint, limit) =>
              todoQueries.pullTodo(checkpoint, limit, pullMode),
            checkpointOf: (row) => ({ id: row.id, updatedAt: row.updatedAt }),
            authorizeRows: (rows) => filterAuthorizedTodoRows(context, rows),
            idOfAuthorized: (row) => row.id,
          })

          // Note: dueAt is now pre-calculated at todo creation time and stored in DB
          const rowsWithSummary =
            yield* summaryComputation.enrichWithSummaries(authorizedRows)

          const documents = yield* Effect.all(
            rowsWithSummary.map((row) => todoOps.mapToGraphql(row)),
            { concurrency: "unbounded" },
          )

          if (isLiveBackfill && authorizedRows.length < args.limit) {
            return wrapAsPullBulk(documents, {
              checkpoint: replicationHead
                ? {
                    ...replicationHead,
                    mode: PullCheckpointMode.Incremental,
                  }
                : null,
            })
          }

          const lastDocument = documents[documents.length - 1]
          if (!lastDocument) {
            return wrapAsPullBulk(documents)
          }

          if (isLiveBackfill && replicationHead) {
            return wrapAsPullBulk(documents, {
              checkpoint: {
                id: lastDocument.id,
                updatedAt: lastDocument.updatedAt,
                mode: PullCheckpointMode.LiveBackfill,
                backfillHead: replicationHead,
              },
            })
          }

          return wrapAsPullBulk(documents, {
            checkpoint: {
              id: lastDocument.id,
              updatedAt: lastDocument.updatedAt,
              mode: PullCheckpointMode.Incremental,
            },
          })
        }),
      pullExecution: (
        _parent: unknown,
        args: RequireFields<QueryPullExecutionArgs, "limit">,
        context: UserContext,
      ) =>
        Effect.gen(function* () {
          const executionOps = yield* ExecutionCollectionOps
          const auth = yield* AuthorizationService
          const principal = yield* buildStepPrincipal(context)

          const authorizedRows = yield* scanAuthorizedPull({
            // The initial union can begin before the synthetic history checkpoint.
            initialCheckpoint: args.includeRunning
              ? null
              : (args.checkpoint ?? null),
            limit: args.limit,
            pull: (checkpoint, limit) =>
              executionOps.pull(
                checkpoint ?? args.checkpoint ?? null,
                limit,
                args.includeRunning === true && checkpoint === null,
                args.historySince ?? undefined,
              ),
            checkpointOf: (row) => ({
              id: row.execution.id,
              updatedAt: row.execution.updatedAt,
            }),
            authorizeRows: (rows) =>
              Effect.gen(function* () {
                const visibleRows = yield* filterAuthorizedExecutionRows(
                  principal,
                  rows,
                )
                const authorized: Array<{
                  row: (typeof rows)[number]
                  canAbandonExecution: boolean
                  canRestartExecution: boolean
                }> = []
                for (const row of visibleRows) {
                  const resource = buildExecutionAuthorizationResource(row)

                  // Failed executions, plus Running roleless starts with a
                  // pending external restart outbox (post-commit drain recovery).
                  const canRestartExecution = yield* Effect.gen(function* () {
                    if (row.execution.status === "Failed") {
                      return yield* auth.canRestartExecution(
                        principal,
                        resource,
                      )
                    }
                    if (
                      row.execution.status !== "Running" ||
                      row.execution.startStepRoleId !== null
                    ) {
                      return false
                    }
                    if (
                      !(yield* hasPendingSystemStartRestartDispatch(
                        row.execution.id,
                      ))
                    ) {
                      return false
                    }
                    return yield* auth.canRestartExecution(principal, resource)
                  })

                  const abandonAuthorization =
                    yield* checkExecutionAbandonAuthorization(
                      principal,
                      row.execution.id,
                      row.execution.status,
                      { startStepPath: row.execution.startStepPath },
                    )

                  authorized.push({
                    row,
                    canAbandonExecution: abandonAuthorization.authorized,
                    canRestartExecution,
                  })
                }
                return authorized
              }),
            idOfAuthorized: ({ row }) => row.execution.id,
          })

          const documents = yield* Effect.all(
            authorizedRows.map(
              ({ row, canAbandonExecution, canRestartExecution }) =>
                executionOps.mapToGraphql(row).pipe(
                  Effect.map((document) => ({
                    ...document,
                    canAbandonExecution,
                    canRestartExecution,
                  })),
                ),
            ),
            { concurrency: "unbounded" },
          )

          return wrapAsPullBulk(documents)
        }),
      // biome-ignore lint/suspicious/noExplicitAny: graphql resolver type mismatch
    } as any,
    Mutation: {
      pushDraftProcessExecution: (
        _parent: unknown,
        args: MutationPushDraftProcessExecutionArgs,
        context: UserContext,
        info: GraphQLResolveInfo,
      ) =>
        Effect.gen(function* () {
          const draftOps = yield* DraftProcessExecutionCollectionOps
          const stepRoleQueries = yield* StepRoleQueries
          const auth = yield* AuthorizationService

          // Check authorization for each write row
          // For drafts, we check if user can start the process (via the start step)
          if (args.writeRows) {
            for (const row of args.writeRows) {
              const persisted = (yield* draftOps.getByIds([
                row.newDocumentState.id,
              ]))[0]

              if (!persisted && !row.assumedMasterState) {
                yield* checkStepAuthorization(
                  context,
                  row.newDocumentState.startStepPath,
                )
                continue
              }

              if (!persisted) {
                return yield* new NotAuthorized({
                  action: "write",
                  resource: row.newDocumentState.id,
                  message: "Draft process execution is not accessible",
                })
              }

              const stepRoleInfo =
                yield* stepRoleQueries.queryRolePathsByStepPath(
                  persisted.startStepPath,
                )
              const principal = yield* buildPrincipal(context)
              const canDraft = yield* trySequentialStepAuthorization(
                stepRoleInfo,
                persisted.startStepPath,
                getProcessPathFromStepPath(persisted.startStepPath),
                (resource) => auth.canDraftStep(principal, resource),
              )
              if (!canDraft) {
                return yield* new NotAuthorized({
                  action: "write",
                  resource: persisted.id,
                  message: "Draft process execution is not accessible",
                })
              }
            }
          }

          // The generic resolver returns { conflicts, successful }, but GraphQL expects just conflicts
          const result = yield* pushDraftProcessExecution(
            args.writeRows,
            info.schema,
          )
          return result.conflicts
        }),
      pushTodo: (
        _parent: unknown,
        args: MutationPushTodoArgs,
        _context: UserContext,
        _info: GraphQLResolveInfo,
      ) =>
        // Phase 1: noop implementation
        pushTodo(args.writeRows).pipe(Effect.map((result) => result.conflicts)),
      // biome-ignore lint/suspicious/noExplicitAny: graphql resolver type mismatch
    } as any,
    Subscription: {
      streamDraftProcessExecution,
      streamTodo,
      streamProcess,
      streamExecution,
    } as unknown as Record<string, unknown>,
  }

  return {
    typeDefs: rxdbTypeDefs,
    resolvers,
  }
})
