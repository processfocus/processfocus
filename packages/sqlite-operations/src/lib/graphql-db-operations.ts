import { Layer } from "effect"
import { SqliteBusinessCalendarQueriesLive } from "./business-calendar-queries"
import { SqliteCleanupOperationsLive } from "./cleanup"
import { SqliteDraftProcessExecutionQueriesLive } from "./draft-process-execution"
import { SqliteExecutionDurationQueriesLive } from "./execution-duration"
import { SqliteExecutionQueriesLive } from "./execution-queries"
import { SqliteExternalParticipantOperationsLive } from "./external-participant"
import { SqliteProcessExecutionOperationsLive } from "./process-execution"
import { SqliteFlowQueriesLive } from "./query-flows"
import { SqliteOAuthClientQueriesLive } from "./query-oauth-client"
import { SqliteOrgQueriesLive } from "./query-org"
import {
  SqliteProcessCollectionQueriesLive,
  SqliteProcessQueriesLive,
} from "./query-processes"
import { SqliteProviderUserQueriesLive } from "./query-provider-user"
import { SqliteWorkflowQueriesLive } from "./query-workflow"
import { SqliteSettingsQueriesLive } from "./settings-queries"
import { SqliteStepCompletionOperationsLive } from "./step-completion"
import { SqliteStepRoleQueriesLive } from "./step-role-queries"
import { SqliteSystemUserOperationsLive } from "./system-user-operations"
import { SqliteTodoQueriesLive } from "./todo-queries"

/**
 * Unified layer providing all GraphQL database operations for SQLite.
 * Combines all individual query and operation services into a single layer.
 */
export const SqliteGraphqlDbOperationsLive = Layer.mergeAll(
  SqliteBusinessCalendarQueriesLive,
  SqliteCleanupOperationsLive,
  SqliteOrgQueriesLive,
  SqliteProcessQueriesLive,
  SqliteProcessCollectionQueriesLive,
  SqliteProviderUserQueriesLive,
  SqliteOAuthClientQueriesLive,
  SqliteProcessExecutionOperationsLive,
  SqliteDraftProcessExecutionQueriesLive,
  SqliteExecutionDurationQueriesLive,
  SqliteExecutionQueriesLive,
  SqliteExternalParticipantOperationsLive,
  SqliteFlowQueriesLive,
  SqliteSettingsQueriesLive,
  SqliteSystemUserOperationsLive,
  SqliteTodoQueriesLive,
  SqliteStepCompletionOperationsLive,
  SqliteStepRoleQueriesLive,
  SqliteWorkflowQueriesLive,
)
