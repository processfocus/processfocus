import { QueueService } from "@processfocus/runtime"
import { Effect, Layer } from "effect"
import { AuthorizationService } from "@pf/auth-policy"

export interface EnqueuedJob {
  readonly queue: string
  readonly payload: unknown
}

/**
 * Capturing QueueService stub for GraphQL DB specs.
 * Records enqueue calls into `enqueuedJobs`; other methods die as unused.
 */
export const makeQueueLayer = (
  enqueuedJobs: EnqueuedJob[],
  queueInTransaction = true,
) =>
  Layer.succeed(QueueService, {
    queueInTransaction,
    enqueue: (queue: string, payload: unknown) =>
      Effect.sync(() => {
        enqueuedJobs.push({ queue, payload })
        return `job-${enqueuedJobs.length}`
      }),
    enqueueWithDelay: () => Effect.dieMessage("not used"),
    rawClaim: () => Effect.dieMessage("not used"),
    acknowledge: () => Effect.dieMessage("not used"),
    fail: () => Effect.dieMessage("not used"),
    extendVisibility: () => Effect.dieMessage("not used"),
    getStats: () => Effect.dieMessage("not used"),
  } as unknown as QueueService["Type"])

export type AuthorizationServiceStub = AuthorizationService["Type"]

/**
 * Base AuthorizationService test stub. All methods deny by default.
 * Pass Partial overrides for methods the test exercises.
 */
export const makeAuthorizationLayer = (
  overrides: Partial<AuthorizationServiceStub> = {},
) =>
  Layer.succeed(AuthorizationService, {
    canIssueDelegationSecret: () => Effect.succeed(false),
    canListDelegationTokens: () => Effect.succeed(false),
    canManageDelegation: () => Effect.succeed(false),
    canLogin: () => Effect.succeed(false),
    canCompleteStep: () => Effect.succeed(false),
    canCompleteTodo: () => Effect.succeed(false),
    canCorrectPublicCompletionTodo: () => Effect.succeed(false),
    canCompletePublicTodo: () => Effect.succeed(false),
    canModifyField: () => Effect.succeed(false),
    canRequestRole: () => Effect.succeed(false),
    canRequestProviderUserPermissions: () => Effect.succeed(false),
    canActOnBehalfOf: () => Effect.succeed(false),
    canViewExecution: () => Effect.succeed(false),
    canRestartExecution: () => Effect.succeed(false),
    canAbandonStep: () => Effect.succeed(false),
    canDraftStep: () => Effect.succeed(false),
    canAccessField: () => Effect.succeed(false),
    canAccessFeature: () => Effect.succeed(false),
    canAccessList: () => Effect.succeed(false),
    canCreateList: () => Effect.succeed(false),
    canUpdateList: () => Effect.succeed(false),
    canDeleteList: () => Effect.succeed(false),
    canDownloadFile: () => Effect.succeed(false),
    canDeleteFile: () => Effect.succeed(false),
    canPerformAction: () => Effect.succeed(false),
    ...overrides,
  })
