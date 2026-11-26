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
    enqueueWithDelay: () => Effect.die(new Error("not used")),
    rawClaim: () => Effect.die(new Error("not used")),
    rawClaimBatch: () => Effect.succeed([]),
    acknowledgeBatch: () => Effect.succeed([]),
    acknowledge: () => Effect.die(new Error("not used")),
    fail: () => Effect.die(new Error("not used")),
    extendVisibility: () => Effect.die(new Error("not used")),
    getStats: () => Effect.die(new Error("not used")),
  } as unknown as QueueService["Service"])

export type AuthorizationServiceStub = AuthorizationService["Service"]

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
    policyVersion: Effect.succeed("test-policy"),
    canCompleteStep: () => Effect.succeed(false),
    canViewEmbeddedForm: () => Effect.succeed(false),
    canCorrectPublicCompletionTodo: () => Effect.succeed(false),
    canModifyField: () => Effect.succeed(false),
    canRequestRole: () => Effect.succeed(false),
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
