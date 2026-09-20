/// <reference types="bun" />

import { FileSystem } from "@effect/platform"
import { DateTime, Effect, Layer } from "effect"
import { AuthorizationService } from "@pf/auth-policy"
import {
  type DraftProcessExecutionRow,
  type ProcessCollectionRow,
  type PullCheckpoint,
  StepRoleQueries,
  TodoQueries,
  type TodoRow,
} from "@pf/graphql-db-operations"
import { PullCheckpointMode, type QueryPullTodoArgs } from "@pf/graphql-schema"
import { TodoSummaryComputation } from "@pf/todo-summary"
import { ResolverRuntime } from "../src/lib/graphql-api"
import { ProcessDurationService } from "../src/lib/process-duration-service"
import { DraftProcessExecutionCollectionOps } from "../src/lib/rxdb/draft-process-execution"
import { ProcessCollectionOps } from "../src/lib/rxdb/process"
import { TodoCollectionOps } from "../src/lib/rxdb/todo"
import { rxdbSchema } from "../src/lib/rxdb-resolvers"
import type { UserContext } from "../src/lib/types"
import { describe, expect, it } from "bun:test"

type TodoCheckpoint = NonNullable<QueryPullTodoArgs["checkpoint"]>

const context: UserContext = {
  _requestTime: undefined as never,
  _userDetails: {
    by: "reviewer@example.com",
    id: "reviewer@example.com",
  } as UserContext["_userDetails"],
  jwt: {
    mode: "access",
    type: "providerUser",
    properties: {
      userId: "usr-reviewer",
      email: "reviewer@example.com",
      roles: ["/Employee"],
      orgUnitPath: "/",
      orgUnitId: "ou-root",
    },
    aud: "graphql-api",
    iss: "http://localhost:4020",
    sub: "providerUser:reviewer",
    exp: 0,
    iat: 0,
  },
  userId: "usr-reviewer",
}

const roleInfo = {
  rolePath: null,
  supportingRolePaths: [],
  startsProcess: true,
  embedded: false,
}

const commonLayers = Layer.mergeAll(
  Layer.succeed(FileSystem.FileSystem, {
    readFileString: () => Effect.succeed("type Query { _: Boolean }"),
  } as unknown as FileSystem.FileSystem),
  Layer.succeed(ResolverRuntime, {
    runPromise: <A, E>(effect: Effect.Effect<A, E, never>) =>
      Effect.runPromise(effect),
  } as never),
  Layer.succeed(StepRoleQueries, {
    queryRolePathsByStepPath: () => Effect.succeed(roleInfo),
    queryRolePathsByStepPaths: (paths: string[]) =>
      Effect.succeed(new Map(paths.map((path) => [path, roleInfo]))),
    queryRoleIdByPath: () => Effect.succeed(undefined),
  }),
  Layer.succeed(AuthorizationService, {
    canIssueDelegationSecret: () => Effect.succeed(false),
    canListDelegationTokens: () => Effect.succeed(false),
    canManageDelegation: () => Effect.succeed(false),
    canLogin: () => Effect.succeed(false),
    canCompleteStep: (_principal, resource) =>
      Effect.succeed(resource.uid.id.includes("allowed")),
    canCompleteTodo: (_principal, resource) =>
      Effect.succeed(resource.uid.id.includes("allowed")),
    canCorrectPublicCompletionTodo: () => Effect.succeed(false),
    canCompletePublicTodo: () => Effect.succeed(false),
    canRequestRole: () => Effect.succeed(false),
    canRequestProviderUserPermissions: () => Effect.succeed(false),
    canActOnBehalfOf: () => Effect.succeed(false),
    canViewExecution: () => Effect.succeed(false),
    canRestartExecution: () => Effect.succeed(false),
    canAbandonStep: () => Effect.succeed(false),
    canDraftStep: (_principal, resource) =>
      Effect.succeed(resource.uid.id.includes("allowed")),
    canModifyField: () => Effect.succeed(false),
    canAccessField: () => Effect.succeed(false),
    canAccessFeature: () => Effect.succeed(false),
    canAccessList: () => Effect.succeed(false),
    canCreateList: () => Effect.succeed(false),
    canUpdateList: () => Effect.succeed(false),
    canDeleteList: () => Effect.succeed(false),
    canDownloadFile: () => Effect.succeed(false),
    canDeleteFile: () => Effect.succeed(false),
    canPerformAction: () => Effect.succeed(false),
  }),
  Layer.succeed(ProcessDurationService, {
    calculateDurations: () => Effect.succeed(new Map()),
  }),
  Layer.succeed(TodoSummaryComputation, {
    enrichWithSummaries: (rows: readonly TodoRow[]) =>
      Effect.succeed([...rows]),
  }),
)

const makePagedPull =
  <Row extends { id: string; updatedAt: number }>(
    deniedRows: Row[],
    allowedRow: Row,
    checkpoints: Array<PullCheckpoint | null>,
  ) =>
  (checkpoint: PullCheckpoint | null | undefined) =>
    Effect.sync(() => {
      checkpoints.push(checkpoint ?? null)
      if (!checkpoint) return deniedRows
      const lastDenied = deniedRows[deniedRows.length - 1]
      return checkpoint.id === lastDenied?.id ? [allowedRow] : []
    })

const makeTodoRow = (
  id: string,
  updatedAt: number,
  deleted = false,
): TodoRow => ({
  id,
  processExecutionId: `execution-${id}`,
  flowId: `flow-${id}`,
  processName: "Pagination",
  stepName: id,
  stepPath: `/process/${id}`,
  processPath: "/process",
  processOrgUnitPath: "/",
  rolePath: null,
  assignedToProviderUserId: null,
  assignedToProviderUserEmail: null,
  role: null,
  description: id,
  status: deleted ? "Completed" : "Active",
  priority: "Medium",
  assignedAt: "2026-07-23T00:00:00.000Z",
  dueAt: null,
  dueWarningAt: null,
  formComplexity: "simple",
  updatedAt,
  deleted,
  summary: [],
})

interface TodoLayerOptions {
  readonly pullTodo: TodoQueries["Type"]["pullTodo"]
  readonly getTodos: (ids: readonly string[]) => TodoRow[]
  readonly getReplicationHead: () => PullCheckpoint | null
}

const makeTodoQueriesLayer = (options: TodoLayerOptions) =>
  Layer.succeed(TodoQueries, {
    pullTodo: options.pullTodo,
    getTodoReplicationHead: () => Effect.sync(options.getReplicationHead),
    getTodos: (ids) => Effect.sync(() => options.getTodos(ids)),
    listTodos: () => Effect.succeed([]),
  })

const makeTodoCollectionLayer = () =>
  Layer.succeed(TodoCollectionOps, {
    pull: () => Effect.succeed([]),
    mapToGraphql: (row) =>
      Effect.succeed({
        id: row.id,
        processExecutionId: row.processExecutionId,
        flowId: row.flowId,
        processName: row.processName,
        stepName: row.stepName,
        stepPath: row.stepPath,
        role: row.role ?? "System",
        description: row.description,
        status: row.status,
        priority: row.priority,
        assignedAt: row.assignedAt,
        dueAt: row.dueAt,
        formComplexity: row.formComplexity,
        updatedAt: row.updatedAt,
        deleted: row.deleted,
        summary: row.summary,
      }),
    insert: () => Effect.succeed("noop"),
    update: () => Effect.succeed("noop"),
    delete: () => Effect.succeed("noop"),
    getByIds: () => Effect.succeed([]),
  })

const makeTodoResolverLayer = (options: TodoLayerOptions) =>
  Layer.merge(makeTodoCollectionLayer(), makeTodoQueriesLayer(options))

const runPull = <Result>(
  field: string,
  layers: Layer.Layer<never>,
  checkpoint?: PullCheckpoint,
): Promise<Result> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const schema = yield* rxdbSchema
      const queryResolvers = schema.resolvers?.Query as
        | Record<string, unknown>
        | undefined
      const resolver = queryResolvers?.[field] as unknown as (
        parent: unknown,
        args: { limit: number; checkpoint?: PullCheckpoint },
        context: UserContext,
      ) => Effect.Effect<Result, unknown, never>
      return yield* resolver(
        undefined,
        checkpoint ? { limit: 2, checkpoint } : { limit: 2 },
        context,
      )
    }).pipe(Effect.provide(Layer.merge(commonLayers, layers))),
  )

describe("authorized pull resolvers", () => {
  it("pullDraftProcessExecution scans beyond an unauthorized raw page", async () => {
    const makeRow = (
      id: string,
      updatedAt: number,
    ): DraftProcessExecutionRow => ({
      id,
      processId: `process-${id}`,
      startStepId: `step-${id}`,
      startedByUserId: "usr-owner",
      startedByEmail: "owner@example.com",
      name: id,
      startStepPath: `/process/${id}`,
      state: {},
      lastSaved: DateTime.unsafeMake(updatedAt),
      updatedAt,
      deleted: false,
    })
    const denied = [makeRow("01-denied", 1), makeRow("02-denied", 1)]
    const allowed = makeRow("03-allowed", 1)
    const checkpoints: Array<PullCheckpoint | null> = []
    const layer = Layer.succeed(DraftProcessExecutionCollectionOps, {
      pull: makePagedPull(denied, allowed, checkpoints),
      mapToGraphql: (row: DraftProcessExecutionRow) =>
        Effect.succeed({ id: row.id, updatedAt: row.updatedAt }),
    } as unknown as DraftProcessExecutionCollectionOps["Type"])

    const result = await runPull<{
      documents: Array<{ id: string }>
      checkpoint: PullCheckpoint | null
    }>("pullDraftProcessExecution", layer)

    expect(checkpoints).toEqual([null, { id: "02-denied", updatedAt: 1 }])
    expect(result.documents.map((document) => document.id)).toEqual([
      "03-allowed",
    ])
    expect(result.checkpoint).toEqual({ id: "03-allowed", updatedAt: 1 })

    const finalResult = await runPull<{
      documents: Array<{ id: string }>
      checkpoint: PullCheckpoint | null
    }>("pullDraftProcessExecution", layer, result.checkpoint ?? undefined)
    expect(finalResult).toEqual({ documents: [], checkpoint: null })
  })

  it("pullProcess scans beyond an unauthorized raw page", async () => {
    const makeRow = (id: string, updatedAt: number): ProcessCollectionRow => ({
      id,
      name: id,
      path: `/process/${id}`,
      purpose: "Test pagination",
      updatedAt,
      deleted: false,
      orgUnit: { id: "ou-root", name: "Root", orgUnitLevel: "organisation" },
      startStepPath: `/process/${id}`,
      formFieldCount: 0,
      activeInstances: 0,
      minDurationMs: null,
      maxDurationMs: null,
    })
    const denied = [makeRow("denied-1", 1), makeRow("denied-2", 2)]
    const allowed = makeRow("allowed-1", 3)
    const checkpoints: Array<PullCheckpoint | null> = []
    const layer = Layer.succeed(ProcessCollectionOps, {
      pull: makePagedPull(denied, allowed, checkpoints),
      mapToGraphql: (row: ProcessCollectionRow) =>
        Effect.succeed({ id: row.id, updatedAt: row.updatedAt }),
    } as unknown as ProcessCollectionOps["Type"])

    const result = await runPull<{
      documents: Array<{ id: string }>
      checkpoint: PullCheckpoint | null
    }>("pullProcess", layer)

    expect(checkpoints).toEqual([null, { id: "denied-2", updatedAt: 2 }])
    expect(result.documents.map((document) => document.id)).toEqual([
      "allowed-1",
    ])
    expect(result.checkpoint).toEqual({ id: "allowed-1", updatedAt: 3 })
  })

  it("pullTodo scans beyond an unauthorized raw page", async () => {
    const denied = [makeTodoRow("denied-1", 1), makeTodoRow("denied-2", 2)]
    const allowed = makeTodoRow("allowed-1", 3)
    const replicationHead = { id: "deleted-head", updatedAt: 4 }
    const deletedHead = makeTodoRow(
      replicationHead.id,
      replicationHead.updatedAt,
      true,
    )
    const checkpoints: Array<PullCheckpoint | null> = []
    const layer = makeTodoResolverLayer({
      pullTodo: makePagedPull(denied, allowed, checkpoints),
      getTodos: (ids) => (ids.includes(deletedHead.id) ? [deletedHead] : []),
      getReplicationHead: () => replicationHead,
    })

    const result = await runPull<{
      documents: Array<{ id: string }>
      checkpoint: TodoCheckpoint | null
    }>("pullTodo", layer)

    expect(checkpoints).toEqual([null, { id: "denied-2", updatedAt: 2 }])
    expect(result.documents.map((document) => document.id)).toEqual([
      "allowed-1",
    ])
    expect(result.checkpoint).toEqual({
      ...replicationHead,
      mode: PullCheckpointMode.Incremental,
    })

    const finalResult = await runPull<{
      documents: Array<{ id: string }>
      checkpoint: TodoCheckpoint | null
    }>("pullTodo", layer, replicationHead)
    expect(finalResult).toEqual({ documents: [], checkpoint: null })
  })

  it("pullTodo snapshots HEAD before scanning a live-backfill page", async () => {
    const events: string[] = []
    const liveRow = makeTodoRow("allowed-1", 1)
    const replicationHead = { id: "deleted-head", updatedAt: 2 }
    const layer = makeTodoResolverLayer({
      pullTodo: () => {
        events.push("pull")
        return Effect.succeed([liveRow])
      },
      getTodos: () => [],
      getReplicationHead: () => {
        events.push("head")
        return replicationHead
      },
    })

    const result = await runPull<{
      documents: Array<{ id: string }>
      checkpoint: TodoCheckpoint | null
    }>("pullTodo", layer)

    expect(events).toEqual(["head", "pull"])
    expect(result.checkpoint).toEqual({
      ...replicationHead,
      mode: PullCheckpointMode.Incremental,
    })
  })

  it("pullTodo keeps a full live-backfill page on its last document", async () => {
    const rows = [makeTodoRow("allowed-1", 1), makeTodoRow("allowed-2", 2)]
    let requestedHead = false
    const layer = makeTodoResolverLayer({
      pullTodo: () => Effect.succeed(rows),
      getTodos: () => [],
      getReplicationHead: () => {
        requestedHead = true
        return { id: "deleted-head", updatedAt: 3 }
      },
    })

    const result = await runPull<{
      documents: Array<{ id: string }>
      checkpoint: TodoCheckpoint | null
    }>("pullTodo", layer)

    expect(result.documents.map(({ id }) => id)).toEqual([
      "allowed-1",
      "allowed-2",
    ])
    expect(result.checkpoint).toEqual({
      id: "allowed-2",
      updatedAt: 2,
      mode: PullCheckpointMode.LiveBackfill,
      backfillHead: { id: "deleted-head", updatedAt: 3 },
    })
    expect(requestedHead).toBe(true)
  })

  it("pullTodo jumps a short live continuation to HEAD", async () => {
    const liveCheckpoint = makeTodoRow("allowed-1", 1)
    const finalLiveRow = makeTodoRow("allowed-2", 2)
    const replicationHead = { id: "deleted-head", updatedAt: 3 }
    const layer = makeTodoResolverLayer({
      pullTodo: () => Effect.succeed([finalLiveRow]),
      getTodos: () => [liveCheckpoint],
      getReplicationHead: () => replicationHead,
    })

    const result = await runPull<{
      documents: Array<{ id: string }>
      checkpoint: TodoCheckpoint | null
    }>("pullTodo", layer, {
      id: liveCheckpoint.id,
      updatedAt: liveCheckpoint.updatedAt,
    })

    expect(result.documents.map(({ id }) => id)).toEqual([finalLiveRow.id])
    expect(result.checkpoint).toEqual({
      ...replicationHead,
      mode: PullCheckpointMode.Incremental,
    })
  })

  it("pullTodo returns a completion after a live HEAD checkpoint", async () => {
    const liveHead = makeTodoRow("allowed-head", 2)
    const todo = makeTodoRow("allowed-todo", 1)
    const completedTodo = makeTodoRow(todo.id, 3, true)
    let completed = false
    const layer = makeTodoResolverLayer({
      pullTodo: (_checkpoint, _limit, mode) =>
        Effect.succeed(
          mode?.kind === "incremental" && completed
            ? [completedTodo]
            : completed
              ? []
              : [todo],
        ),
      getTodos: (ids) => {
        if (ids.includes(liveHead.id)) return [liveHead]
        if (ids.includes(completedTodo.id) && completed) {
          return [completedTodo]
        }
        return []
      },
      getReplicationHead: () =>
        completed
          ? {
              id: completedTodo.id,
              updatedAt: completedTodo.updatedAt,
            }
          : { id: liveHead.id, updatedAt: liveHead.updatedAt },
    })

    const initialResult = await runPull<{
      documents: Array<{ id: string }>
      checkpoint: TodoCheckpoint | null
    }>("pullTodo", layer)
    expect(initialResult.checkpoint).toEqual({
      id: liveHead.id,
      updatedAt: liveHead.updatedAt,
      mode: PullCheckpointMode.Incremental,
    })

    completed = true
    const incrementalResult = await runPull<{
      documents: Array<{ id: string; deleted: boolean }>
      checkpoint: TodoCheckpoint | null
    }>("pullTodo", layer, initialResult.checkpoint ?? undefined)

    expect(
      incrementalResult.documents.map(({ id, deleted }) => ({ id, deleted })),
    ).toEqual([{ id: completedTodo.id, deleted: true }])
  })

  it("pullTodo keeps later completions beyond an exactly-full backfill HEAD", async () => {
    const firstTodo = makeTodoRow("allowed-1", 1)
    const liveHead = makeTodoRow("allowed-2", 2)
    const completedTodo = makeTodoRow(firstTodo.id, 3, true)
    let completed = false
    const layer = makeTodoResolverLayer({
      pullTodo: (checkpoint, _limit, mode) => {
        if (!checkpoint) return Effect.succeed([firstTodo, liveHead])
        if (mode?.kind === "incremental" && completed) {
          return Effect.succeed([completedTodo])
        }
        return Effect.succeed([])
      },
      getTodos: () => [],
      getReplicationHead: () =>
        completed
          ? { id: completedTodo.id, updatedAt: completedTodo.updatedAt }
          : { id: liveHead.id, updatedAt: liveHead.updatedAt },
    })

    const fullPage = await runPull<{
      documents: Array<{ id: string }>
      checkpoint: TodoCheckpoint | null
    }>("pullTodo", layer)
    expect(fullPage.checkpoint).toEqual({
      id: liveHead.id,
      updatedAt: liveHead.updatedAt,
      mode: PullCheckpointMode.LiveBackfill,
      backfillHead: { id: liveHead.id, updatedAt: liveHead.updatedAt },
    })

    completed = true
    const endOfBackfill = await runPull<{
      documents: Array<{ id: string }>
      checkpoint: TodoCheckpoint | null
    }>("pullTodo", layer, fullPage.checkpoint ?? undefined)
    expect(endOfBackfill).toEqual({
      documents: [],
      checkpoint: {
        id: liveHead.id,
        updatedAt: liveHead.updatedAt,
        mode: PullCheckpointMode.Incremental,
      },
    })

    const incrementalPage = await runPull<{
      documents: Array<{ id: string; deleted: boolean }>
      checkpoint: TodoCheckpoint | null
    }>("pullTodo", layer, endOfBackfill.checkpoint ?? undefined)
    expect(
      incrementalPage.documents.map(({ id, deleted }) => ({ id, deleted })),
    ).toEqual([{ id: completedTodo.id, deleted: true }])
  })

  it("pullTodo keeps a short incremental page on its deleted document", async () => {
    const replicationHead = makeTodoRow("deleted-head", 3, true)
    const completedAfterHead = makeTodoRow(
      "allowed-completed-after-head",
      4,
      true,
    )
    let requestedHead = false
    const layer = makeTodoResolverLayer({
      pullTodo: () => Effect.succeed([completedAfterHead]),
      getTodos: () => [replicationHead],
      getReplicationHead: () => {
        requestedHead = true
        return { id: "new-head", updatedAt: 5 }
      },
    })

    const result = await runPull<{
      documents: Array<{ id: string; updatedAt: number; deleted: boolean }>
      checkpoint: TodoCheckpoint | null
    }>("pullTodo", layer, {
      id: replicationHead.id,
      updatedAt: replicationHead.updatedAt,
    })

    expect(
      result.documents.map(({ id, updatedAt, deleted }) => ({
        id,
        updatedAt,
        deleted,
      })),
    ).toEqual([{ id: completedAfterHead.id, updatedAt: 4, deleted: true }])
    expect(result.checkpoint).toEqual({
      id: completedAfterHead.id,
      updatedAt: completedAfterHead.updatedAt,
      mode: PullCheckpointMode.Incremental,
    })
    expect(requestedHead).toBe(false)
  })
})
