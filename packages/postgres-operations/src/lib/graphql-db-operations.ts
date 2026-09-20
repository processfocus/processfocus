import { Layer } from "effect"
import { PostgresBusinessCalendarQueriesLive } from "./business-calendar-queries"
import { PostgresCleanupOperationsLive } from "./cleanup"
import { PostgresDraftProcessExecutionQueriesLive } from "./draft-process-execution"
import { PostgresExecutionDurationQueriesLive } from "./execution-duration"
import { PostgresExecutionQueriesLive } from "./execution-queries"
import { PostgresExternalParticipantOperationsLive } from "./external-participant"
import { PostgresProcessExecutionOperationsLive } from "./process-execution"
import { PostgresFlowQueriesLive } from "./query-flows"
import { PostgresOAuthClientQueriesLive } from "./query-oauth-client"
import { PostgresOrgQueriesLive } from "./query-org"
import {
  PostgresProcessCollectionQueriesLive,
  PostgresProcessQueriesLive,
} from "./query-processes"
import { PostgresProviderUserQueriesLive } from "./query-provider-user"
import { PostgresWorkflowQueriesLive } from "./query-workflow"
import { PostgresSettingsQueriesLive } from "./settings-queries"
import { PostgresStepCompletionOperationsLive } from "./step-completion"
import { PostgresStepRoleQueriesLive } from "./step-role-queries"
import { PostgresSystemUserOperationsLive } from "./system-user-operations"
import { PostgresTodoQueriesLive } from "./todo-queries"

/**
 * Unified layer providing all GraphQL database operations for PostgreSQL.
 * Combines all individual query and operation services into a single layer.
 */
export const PostgresGraphqlDbOperationsLive = Layer.mergeAll(
  PostgresBusinessCalendarQueriesLive,
  PostgresCleanupOperationsLive,
  PostgresOrgQueriesLive,
  PostgresProcessQueriesLive,
  PostgresProcessCollectionQueriesLive,
  PostgresProviderUserQueriesLive,
  PostgresOAuthClientQueriesLive,
  PostgresProcessExecutionOperationsLive,
  PostgresDraftProcessExecutionQueriesLive,
  PostgresExecutionDurationQueriesLive,
  PostgresExecutionQueriesLive,
  PostgresExternalParticipantOperationsLive,
  PostgresFlowQueriesLive,
  PostgresSettingsQueriesLive,
  PostgresSystemUserOperationsLive,
  PostgresTodoQueriesLive,
  PostgresStepCompletionOperationsLive,
  PostgresStepRoleQueriesLive,
  PostgresWorkflowQueriesLive,
)
