import {
  ExecutorError,
  ExecutorHost,
  FileResolutionHost,
} from "@processfocus/runtime"
import { DateTime, Effect, FiberRef, Layer } from "effect"
import { AuthorizationService } from "@pf/auth-policy"
import { UserDetails, type UserDetailsValue } from "@pf/graphql-db-operations"
import {
  ExecutionFromJobPublisher,
  ProcessFromJobPublisher,
  TodoFromJobPublisher,
  makeNotificationDeliveryConfig,
} from "@pf/job-handler"
import {
  ConditionEvaluator,
  ForEachItemsResolver,
  type Organisation,
  OrganisationProviderTest,
  ScheduleEvaluator,
  SystemStepExecutor,
  makeConditionEvaluator,
  makeForEachItemsResolver,
  makeScheduleEvaluator,
  makeSystemStepExecutor,
} from "@pf/process"
import { RequestTime } from "@pf/request-time"
import { DatabaseTest } from "@pf/service-drizzle-sqlite/test"
import {
  SqliteCompletedJobOperationsLive,
  SqliteDbOperationsLive,
  SqliteFlowExecutionOperationsLive,
  SqliteGraphqlDbOperationsLive,
  SqliteScheduledFlowOperationsLive,
} from "@pf/sqlite-operations"
import { SqliteQueueServiceLive } from "@pf/sqlite-queue-service"

/**
 * RequestTime layer: initialized with a default value.
 * The drain loop sets the current time for each job.
 */
const RequestTimeLive = Layer.effect(
  RequestTime,
  Effect.map(DateTime.now, (now) => FiberRef.unsafeMake(now)),
)

/**
 * UserDetails layer: SYSTEM user for test runner operations.
 * The id is null because no real user record exists in the test DB,
 * and the started_by_user FK column is nullable.
 */
const UserDetailsLive = Layer.succeed(
  UserDetails,
  FiberRef.unsafeMake({
    by: "SYSTEM",
    id: null,
  }) as FiberRef.FiberRef<UserDetailsValue>,
)

const AllowAllAuthorizationLive = Layer.succeed(AuthorizationService, {
  canIssueDelegationSecret: () => Effect.succeed(false),
  canListDelegationTokens: () => Effect.succeed(false),
  canManageDelegation: () => Effect.succeed(false),
  canLogin: () => Effect.succeed(true),
  canCompleteStep: () => Effect.succeed(true),
  canCompleteTodo: () => Effect.succeed(true),
  canCorrectPublicCompletionTodo: () => Effect.succeed(true),
  canCompletePublicTodo: () => Effect.succeed(true),
  canRequestRole: () => Effect.succeed(true),
  canRequestProviderUserPermissions: () => Effect.succeed(true),
  canActOnBehalfOf: () => Effect.succeed(true),
  canViewExecution: () => Effect.succeed(true),
  canRestartExecution: () => Effect.succeed(true),
  canAbandonStep: () => Effect.succeed(true),
  canDraftStep: () => Effect.succeed(true),
  canModifyField: () => Effect.succeed(true),
  canAccessField: () => Effect.succeed(true),
  canAccessFeature: () => Effect.succeed(true),
  canAccessList: () => Effect.succeed(true),
  canCreateList: () => Effect.succeed(true),
  canUpdateList: () => Effect.succeed(true),
  canDeleteList: () => Effect.succeed(true),
  canDownloadFile: () => Effect.succeed(true),
  canDeleteFile: () => Effect.succeed(true),
  canPerformAction: () => Effect.succeed(true),
})

/**
 * No-op TodoFromJobPublisher: events are irrelevant for testing.
 */
const MockTodoFromJobPublisherLayer = Layer.succeed(TodoFromJobPublisher, {
  publishTodosCreated: () => Effect.void,
})

/**
 * No-op ProcessFromJobPublisher: events are irrelevant for testing.
 */
const MockProcessFromJobPublisherLayer = Layer.succeed(
  ProcessFromJobPublisher,
  {
    publishProcessChanged: () => Effect.succeed("published" as const),
  },
)

/**
 * No-op ExecutionFromJobPublisher: events are irrelevant for testing.
 */
const MockExecutionFromJobPublisherLayer = Layer.succeed(
  ExecutionFromJobPublisher,
  {
    publishExecutionChanged: () => Effect.succeed("published" as const),
  },
)

const MockFileResolutionHostLayer = Layer.succeed(FileResolutionHost, {
  resolveDownloadUrl: ({ fileId, storePrefix }) =>
    Effect.succeed(`file:///pf/document-store/${storePrefix}/${fileId}`),
})

const MockExecutorHostLayer = Layer.succeed(ExecutorHost, {
  run: (_invocation, jobContext) =>
    Effect.fail(
      new ExecutorError({
        message: `DockerStep "${jobContext.stepPath}" is not supported by process-test-runner`,
      }),
    ),
})

/**
 * Creates the full test layer for the process test runner.
 *
 * @param org - The organisation whose processes will be tested
 * @param customDbLayer - Optional custom DB layer (for org-specific services)
 */
export const createTestLayers = (
  org: Organisation,
  // biome-ignore lint/suspicious/noExplicitAny: Layer generics vary per org
  customDbLayer?: Layer.Layer<any, any, any>,
) => {
  // Process evaluation layers from the organisation
  const ConditionEvaluatorLive = Layer.succeed(
    ConditionEvaluator,
    makeConditionEvaluator(org),
  )
  // Always returns past time to skip delays in tests
  const ScheduleEvaluatorLive = Layer.succeed(
    ScheduleEvaluator,
    makeScheduleEvaluator(org),
  )
  const SystemStepExecutorLive = Layer.succeed(
    SystemStepExecutor,
    makeSystemStepExecutor(org),
  )
  const ForEachItemsResolverLive = Layer.succeed(
    ForEachItemsResolver,
    makeForEachItemsResolver(org),
  )

  // Base database layer: in-memory SQLite + migrations + DbOperations
  const BaseDbLayer = Layer.provideMerge(SqliteDbOperationsLive, DatabaseTest)

  // Operation layers that depend on TypedSqliteDrizzle
  const OperationLayers = Layer.provideMerge(
    Layer.mergeAll(
      SqliteFlowExecutionOperationsLive,
      SqliteScheduledFlowOperationsLive,
      SqliteCompletedJobOperationsLive,
      SqliteGraphqlDbOperationsLive,
    ),
    BaseDbLayer,
  )

  // Independent layers (no TypedSqliteDrizzle dependency)
  const IndependentLayers = Layer.mergeAll(
    ConditionEvaluatorLive,
    ScheduleEvaluatorLive,
    SystemStepExecutorLive,
    ForEachItemsResolverLive,
    OrganisationProviderTest(org),
    RequestTimeLive,
    UserDetailsLive,
    AllowAllAuthorizationLive,
    makeNotificationDeliveryConfig(() => "http://localhost:3000"),
    SqliteQueueServiceLive,
    MockFileResolutionHostLayer,
    MockExecutorHostLayer,
    MockTodoFromJobPublisherLayer,
    MockProcessFromJobPublisherLayer,
    MockExecutionFromJobPublisherLayer,
  )

  // Compose all layers
  let layers = Layer.mergeAll(IndependentLayers, OperationLayers, BaseDbLayer)

  // Merge custom DB layer if provided (for org-specific services).
  // provideMerge(customDbLayer, layers) feeds layers' output (SqlClient etc.)
  // into customDbLayer's input, and merges both outputs.
  if (customDbLayer) {
    layers = Layer.provideMerge(customDbLayer, layers) as typeof layers
  }

  return layers
}
