import type { SqlError } from "@effect/sql/SqlError"
import { Context, Data, type Effect } from "effect"
import type {
  ExtractedDocumentStoreData,
  ExtractedFlowData,
  ExtractedHolidayRuleData,
  ExtractedOrgUnitData,
  ExtractedPhaseData,
  ExtractedProcessData,
  ExtractedRoleData,
  ExtractedRoleResponsibilityData,
  ExtractedStepData,
  ExtractedWeeklyScheduleData,
} from "./types"

export interface RoleResponsibilityKey {
  readonly processPath: string
  readonly rolePath: string
}

export interface WeeklyScheduleKey {
  readonly orgUnitPath: string
  readonly dayOfWeek: number
}

export interface HolidayRuleKey {
  readonly orgUnitPath: string
  readonly holidayTitle: string
}

export interface StepDocumentStoreKey {
  readonly stepPath: string
  readonly documentStorePath: string
}

/**
 * Error thrown when a flow connects steps from different processes.
 */
export class FlowCrossProcessError extends Data.TaggedError(
  "FlowCrossProcessError",
)<{
  readonly sourceStepId: string
  readonly targetStepId: string
  readonly sourceProcessId: string
  readonly targetProcessId: string
}> {}

/**
 * Database operations service interface.
 *
 * This service provides all database operations for storing organisation structures.
 * Implementations are provided by database-specific packages:
 * - @pf/postgres-operations for PostgreSQL
 * - @pf/sqlite-operations for SQLite
 *
 * All operations should be called within a transaction using SqlClient.withTransaction.
 * Operations can fail with SqlError from database errors (and FlowCrossProcessError for
 * upsertFlow when steps belong to different processes).
 *
 * Upsert operations return the database-generated primary key for the inserted/updated record.
 */
export interface DbOperationsService<R = never> {
  /**
   * Upserts a single organizational unit and returns its database PK.
   * @param orgUnit - The org unit data to upsert
   * @param parentOrgUnitId - Optional parent org unit database PK
   * @returns Database-generated primary key (ULID)
   */
  readonly upsertOrgUnit: (
    orgUnit: Omit<ExtractedOrgUnitData, "processes" | "roles" | "children">,
    parentOrgUnitId?: string,
  ) => Effect.Effect<string, SqlError, R>

  /**
   * Upserts a single process and returns its database PK.
   * @param process - The process data to upsert (without steps/flows/responsibilities/phases)
   * @param orgUnitId - Parent org unit database PK
   * @returns Database-generated primary key (ULID)
   */
  readonly upsertProcess: (
    process: Omit<
      ExtractedProcessData,
      "steps" | "flows" | "responsibilities" | "phases"
    >,
    orgUnitId: string,
  ) => Effect.Effect<string, SqlError, R>

  /**
   * Upserts a single role and returns its database PK.
   * @param role - The role data to upsert
   * @param orgUnitId - Parent org unit database PK
   * @returns Database-generated primary key (ULID)
   */
  readonly upsertRole: (
    role: ExtractedRoleData,
    orgUnitId: string,
  ) => Effect.Effect<string, SqlError, R>

  /**
   * Upserts a single phase and returns its database PK.
   * @param phase - The phase data to upsert (includes order)
   * @param processId - Parent process database PK
   * @returns Database-generated primary key (ULID)
   */
  readonly upsertPhase: (
    phase: ExtractedPhaseData,
    processId: string,
  ) => Effect.Effect<string, SqlError, R>

  /**
   * Upserts a single step and returns its database PK.
   * @param step - The step data to upsert
   * @param processId - Parent process database PK
   * @param phaseId - Optional phase database PK
   * @returns Database-generated primary key (ULID)
   */
  readonly upsertStep: (
    step: ExtractedStepData,
    processId: string,
    phaseId?: string,
  ) => Effect.Effect<string, SqlError, R>

  /**
   * Upserts a role responsibility for a process.
   * @param responsibility - The responsibility data to upsert
   * @param processId - Process database PK
   * @param roleId - Role database PK
   */
  readonly upsertRoleResponsibility: (
    responsibility: ExtractedRoleResponsibilityData,
    processId: string,
    roleId: string,
  ) => Effect.Effect<void, SqlError, R>

  /**
   * Upserts a single flow (no PK needed as return value).
   * Validates that both source and target steps belong to the same process.
   * @param flow - The flow data to upsert
   * @param sourceStepId - Source step database PK
   * @param targetStepId - Target step database PK
   * @throws FlowCrossProcessError if steps belong to different processes
   */
  readonly upsertFlow: (
    flowKey: string,
    flow: ExtractedFlowData,
    sourceStepId: string,
    targetStepId: string,
  ) => Effect.Effect<void, SqlError | FlowCrossProcessError, R>

  /**
   * Deletes flows not in the current organisation structure.
   */
  readonly deleteOrphanedFlows: (
    currentFlowIds: string[],
  ) => Effect.Effect<void, SqlError, R>

  /**
   * Deletes steps not in the current organisation structure.
   */
  readonly deleteOrphanedSteps: (
    currentStepIds: string[],
  ) => Effect.Effect<void, SqlError, R>

  /**
   * Deletes roles not in the current organisation structure.
   */
  readonly deleteOrphanedRoles: (
    currentRoleIds: string[],
  ) => Effect.Effect<void, SqlError, R>

  /**
   * Deletes processes not in the current organisation structure.
   */
  readonly deleteOrphanedProcesses: (
    currentProcessIds: string[],
  ) => Effect.Effect<void, SqlError, R>

  /**
   * Deletes org units not in the current organisation structure.
   */
  readonly deleteOrphanedOrgUnits: (
    currentOrgUnitIds: string[],
  ) => Effect.Effect<void, SqlError, R>

  /**
   * Deletes phases not in the current organisation structure.
   */
  readonly deleteOrphanedPhases: (
    currentPhasePaths: string[],
  ) => Effect.Effect<void, SqlError, R>

  /**
   * Deletes role responsibilities not in the current organisation structure.
   */
  readonly deleteOrphanedRoleResponsibilities: (
    currentKeys: RoleResponsibilityKey[],
  ) => Effect.Effect<void, SqlError, R>

  /**
   * Upserts an OAuth provider configuration.
   * @param providerName - The provider name (e.g., "google", "github")
   * @param config - The OAuth configuration as a JSON-serializable object
   */
  readonly upsertOAuthProvider: (
    providerName: string,
    config: Record<string, unknown>,
  ) => Effect.Effect<void, SqlError, R>

  /**
   * Deletes OAuth providers not in the current configuration.
   * @param currentProviderNames - Array of provider names to keep
   */
  readonly deleteOrphanedOAuthProviders: (
    currentProviderNames: string[],
  ) => Effect.Effect<void, SqlError, R>

  /**
   * Upserts an invitation and its associated roles.
   * @param invitation - The invitation data to upsert (id and email only)
   * @param roleIds - Array of role database PKs to assign
   * @returns Database-generated primary key (ULID)
   */
  readonly upsertInvitation: (
    invitation: { id: string; email: string },
    roleIds: string[],
  ) => Effect.Effect<string, SqlError, R>

  /**
   * Soft-deletes pending model-owned invitations (and their role links) whose
   * construct ids are no longer present in the organisation model.
   *
   * Only `invitation_source = model` and `invitation_status = pending` rows are
   * cleaned. Dashboard, process, and unresolved legacy sources survive, as do
   * accepted and legacy-closed model history. Ownership is the stored source
   * column — never inferred from invitation_id formatting.
   *
   * @param currentInvitationIds - Construct ids of invitations still in the model
   */
  readonly deleteOrphanedInvitations: (
    currentInvitationIds: string[],
  ) => Effect.Effect<void, SqlError, R>

  /**
   * Upserts an OAuth client for M2M authentication.
   * @param clientId - The client identifier
   * @param secretHash - The Argon2id hash of the client secret
   * @param audience - The audience claim for tokens issued to this client
   */
  readonly upsertOAuthClient: (
    clientId: string,
    secretHash: string,
    audience: string,
  ) => Effect.Effect<void, SqlError, R>

  /**
   * Deletes OAuth clients not in the current configuration.
   * @param currentClientIds - Array of client IDs to keep
   */
  readonly deleteOrphanedOAuthClients: (
    currentClientIds: string[],
  ) => Effect.Effect<void, SqlError, R>

  /**
   * Upserts a weekly schedule entry for a specific day.
   * @param schedule - The weekly schedule data to upsert
   * @param orgUnitId - Org unit database PK
   */
  readonly upsertWeeklySchedule: (
    schedule: ExtractedWeeklyScheduleData,
    orgUnitId: string,
  ) => Effect.Effect<void, SqlError, R>

  /**
   * Deletes weekly schedules not in the current configuration.
   */
  readonly deleteOrphanedWeeklySchedules: (
    currentKeys: WeeklyScheduleKey[],
  ) => Effect.Effect<void, SqlError, R>

  /**
   * Upserts a holiday rule.
   * @param holiday - The holiday rule data to upsert
   * @param orgUnitId - Org unit database PK
   */
  readonly upsertHolidayRule: (
    holiday: ExtractedHolidayRuleData,
    orgUnitId: string,
  ) => Effect.Effect<void, SqlError, R>

  /**
   * Deletes holiday rules not in the current configuration.
   */
  readonly deleteOrphanedHolidayRules: (
    currentKeys: HolidayRuleKey[],
  ) => Effect.Effect<void, SqlError, R>

  /**
   * Upserts a document store configuration.
   * @param data - The document store data to upsert
   * @param orgUnitId - Org unit database PK
   * @returns Database-generated primary key (ULID)
   */
  readonly upsertDocumentStore: (
    data: ExtractedDocumentStoreData,
    orgUnitId: string,
  ) => Effect.Effect<string, SqlError, R>

  /**
   * Deletes document stores not in the current configuration.
   * @param currentPaths - Array of document store paths to keep
   */
  readonly deleteOrphanedDocumentStores: (
    currentPaths: string[],
  ) => Effect.Effect<void, SqlError, R>

  /**
   * Upserts a step-document-store junction entry.
   * Creates a link between a step and a document store for authorization.
   * @param stepId - Step database PK
   * @param documentStoreId - Document store database PK
   */
  readonly upsertStepDocumentStore: (
    stepId: string,
    documentStoreId: string,
  ) => Effect.Effect<void, SqlError, R>

  /**
   * Deletes step-document-store junction entries not in the current configuration.
   */
  readonly deleteOrphanedStepDocumentStores: (
    currentKeys: StepDocumentStoreKey[],
  ) => Effect.Effect<void, SqlError, R>
}

/**
 * Context tag for database operations service injection.
 *
 * This tag should be implemented by database-specific packages.
 * Consumers should provide the appropriate implementation layer when running their Effects.
 *
 * Note: Uses `any` for the requirement parameter. This is necessary for a generic service
 * tag that accepts multiple implementations (PostgreSQL, SQLite) with different requirements.
 * Type safety is maintained through the specific implementation layers
 * (PostgresDbOperationsLive, SqliteDbOperationsLive) which have explicit requirements.
 */
export class DbOperations extends Context.Tag("@pf/org-to-db/DbOperations")<
  DbOperations,
  // biome-ignore lint/suspicious/noExplicitAny: Required for generic service tag accepting multiple DB implementations; never/unknown will not work
  DbOperationsService<any>
>() {}
