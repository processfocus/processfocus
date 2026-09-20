/// <reference types="bun" />

import { FileSystem } from "@effect/platform"
import { Effect, Layer } from "effect"
import { AuthorizationService } from "@pf/auth-policy"
import { ResolverRuntime } from "../src/lib/graphql-api"
import { ExecutionCollectionOps } from "../src/lib/rxdb/execution"
import { rxdbSchema } from "../src/lib/rxdb-resolvers"
import type { UserContext } from "../src/lib/types"
import { describe, expect, it } from "bun:test"

const makeContext = (): UserContext => ({
  _requestTime: undefined as never,
  _userDetails: {
    by: "alice@example.com",
    id: "alice@example.com",
  } as UserContext["_userDetails"],
  jwt: {
    mode: "access",
    type: "providerUser",
    properties: {
      userId: "usr-1",
      email: "alice@example.com",
      roles: ["/Administrator"],
      orgUnitPath: "/",
      orgUnitId: "ou-root",
    },
    aud: "graphql-api",
    iss: "http://localhost:4020",
    sub: "providerUser:alice",
    exp: 0,
    iat: 0,
  },
  userId: "usr-1",
})

const makeExecutionRow = (id: string, updatedAt: number) => ({
  execution: {
    id,
    processStateId: `pst-${id}`,
    processName: "Deploy",
    processPath: "/operations/deploy",
    status: "Completed" as const,
    startedAt: "2026-04-10T00:00:00Z",
    finishedAt: "2026-04-10T00:01:00Z",
    durationMs: 60_000,
    updatedAt,
    deleted: false,
    startStepId: "step-start",
    startStepName: "Start",
    startStepPath: "/operations/deploy/Start",
    startStepRoleId: "role-admin",
    startStepRoleName: "Administrator",
    startStepRoleOrgUnitPath: "/",
    startedByRoleId: null,
    startedByRoleName: null,
    startedByRolePath: null,
    startStepEmbedded: false,
    startStepExternalParticipantId: null,
    startStepExternalParticipantEmail: null,
    processStateCreatedAt: "2026-04-10T00:00:00Z",
    startedByEmail: "alice@example.com",
    startedById: "pu-1",
    startedByFirstName: "Alice",
    startedByLastName: "Example",
    startedByPicture: null,
    startedByOrgUnit: "Console",
    processSlaValue: null,
    processSlaUnit: null,
    processSlaWarning: null,
    typicalDurationMinMs: null,
    typicalDurationMaxMs: null,
    processOrgUnitId: "ou-root",
    abandonedReason: null,
  },
  steps: [{ status: "Completed" as const, roleOrgUnitPath: "/" }],
  completedSteps: 1,
  totalSteps: 1,
  slaTargets: {
    slaTargetAt: null,
    slaWarningAt: null,
    estimatedCompletionAt: null,
  },
})

describe("rxdbSchema pullExecution", () => {
  it.each([false, true])(
    "keeps paging until it fills the authorized page (includeRunning=%s)",
    async (includeRunning) => {
      const unauthorized1 = makeExecutionRow("pex-unauthorized-1", 1)
      const unauthorized2 = makeExecutionRow("pex-unauthorized-2", 2)
      const unauthorized3 = makeExecutionRow("pex-unauthorized-3", 3)
      const authorized1 = makeExecutionRow("pex-authorized-1", 4)
      const authorized2 = makeExecutionRow("pex-authorized-2", 5)
      const authorized3 = makeExecutionRow("pex-authorized-3", 6)
      const pullCheckpoints: Array<{ id: string; updatedAt: number } | null> =
        []

      const inclusionFlags: boolean[] = []
      const layers = Layer.mergeAll(
        Layer.succeed(FileSystem.FileSystem, {
          readFileString: () => Effect.succeed("type Query { _: Boolean }"),
        } as unknown as FileSystem.FileSystem),
        Layer.succeed(ResolverRuntime, {
          runPromise: <A, E>(effect: Effect.Effect<A, E, never>) =>
            Effect.runPromise(effect),
        } as never),
        Layer.succeed(ExecutionCollectionOps, {
          pull: (
            checkpoint: { id: string; updatedAt: number } | null,
            _limit: number,
            requestedRunning = false,
          ) =>
            Effect.sync(() => {
              pullCheckpoints.push(checkpoint)
              inclusionFlags.push(requestedRunning)

              if (!checkpoint || requestedRunning) {
                return [unauthorized1, unauthorized2, unauthorized3]
              }

              if (checkpoint.id === "pex-unauthorized-3") {
                return [authorized1, authorized2, authorized3]
              }

              return []
            }),
          mapToGraphql: (row: ReturnType<typeof makeExecutionRow>) =>
            Effect.succeed({
              id: row.execution.id,
              updatedAt: row.execution.updatedAt,
              processStateId: row.execution.processStateId,
              processName: row.execution.processName,
              processPath: row.execution.processPath,
              status: row.execution.status,
              failureReason: null,
              abandonedReason: null,
              startedAt: row.execution.startedAt,
              finishedAt: row.execution.finishedAt,
              completedSteps: row.completedSteps,
              totalSteps: row.totalSteps,
              durationMs: row.execution.durationMs,
              estimatedCompletionAt: null,
              slaWarningAt: null,
              slaTargetAt: null,
              deleted: false,
              steps: [],
            }),
        } as unknown as ExecutionCollectionOps["Type"]),
        Layer.succeed(AuthorizationService, {
          canIssueDelegationSecret: () => Effect.succeed(false),
          canListDelegationTokens: () => Effect.succeed(false),
          canManageDelegation: () => Effect.succeed(false),
          canLogin: () => Effect.succeed(false),
          canCompleteStep: () => Effect.succeed(false),
          canCompleteTodo: () => Effect.succeed(false),
          canCorrectPublicCompletionTodo: () => Effect.succeed(false),
          canCompletePublicTodo: () => Effect.succeed(false),
          canRequestRole: () => Effect.succeed(false),
          canRequestProviderUserPermissions: () => Effect.succeed(false),
          canActOnBehalfOf: () => Effect.succeed(false),
          canViewExecution: (_principal, resource) =>
            Effect.succeed(!resource.uid.id.includes("unauthorized")),
          canRestartExecution: () => Effect.succeed(false),
          canAbandonStep: () => Effect.succeed(false),
          canDraftStep: () => Effect.succeed(false),
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
      )

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const schema = yield* rxdbSchema
          const resolver = (schema.resolvers?.Query?.["pullExecution"] ??
            (() =>
              Effect.dieMessage(
                "Missing pullExecution resolver",
              ))) as unknown as (
            parent: unknown,
            args: {
              limit: number
              includeRunning?: boolean
              checkpoint?: { id: string; updatedAt: number }
            },
            context: UserContext,
          ) => Effect.Effect<
            {
              documents: Array<{ id: string }>
              checkpoint: { id: string; updatedAt: number } | null
            },
            unknown,
            never
          >

          return yield* resolver(
            undefined,
            {
              limit: 3,
              includeRunning,
              ...(includeRunning
                ? { checkpoint: { id: "", updatedAt: 100 } }
                : {}),
            },
            makeContext(),
          )
        }).pipe(Effect.provide(layers)),
      )

      expect(inclusionFlags).toEqual([includeRunning, false])
      expect(pullCheckpoints).toEqual([
        includeRunning ? { id: "", updatedAt: 100 } : null,
        { id: "pex-unauthorized-3", updatedAt: 3 },
      ])
      expect(result.documents.map((document) => document.id)).toEqual([
        "pex-authorized-1",
        "pex-authorized-2",
        "pex-authorized-3",
      ])
      expect(result.checkpoint).toEqual({
        id: "pex-authorized-3",
        updatedAt: 6,
      })
    },
  )
})
