import { createHash } from "node:crypto"
import { SqlClient } from "@effect/sql"
import type { SqlError } from "@effect/sql/SqlError"
import { Data, Effect, HashMap, Option, Ref } from "effect"
import type { Organisation } from "@pf/process"
import {
  DbOperations,
  type DbOperationsService,
  type FlowCrossProcessError,
  type HolidayRuleKey,
  type RoleResponsibilityKey,
  type StepDocumentStoreKey,
  type WeeklyScheduleKey,
} from "./db-operations"
import { hashSecret } from "./secret-hash"
import {
  isTransientTursoServerError,
  retryTransientTursoServerError,
} from "./transient-turso-error"
import type { ExtractedOrgUnitData } from "./types"
import {
  walkAuthenticationConfig,
  walkDocumentStores,
  walkInvitations,
  walkOrganisation,
  walkSecretClients,
} from "./walker"

/**
 * Helper to get all descendant org units recursively.
 */
const getAllDescendantOrgUnits = (
  orgUnit: ExtractedOrgUnitData,
): ExtractedOrgUnitData[] => {
  const descendants: ExtractedOrgUnitData[] = []
  for (const child of orgUnit.children) {
    descendants.push(child)
    descendants.push(...getAllDescendantOrgUnits(child))
  }
  return descendants
}

const buildFlowFingerprint = (params: {
  sourceStepPath: string
  targetStepPath: string
  isElse: boolean
  isOnError: boolean
  taggedErrors: readonly string[] | null
}) =>
  [
    `source:${params.sourceStepPath}`,
    `target:${params.targetStepPath}`,
    `else:${params.isElse ? 1 : 0}`,
    `onError:${params.isOnError ? 1 : 0}`,
    `tags:${params.taggedErrors ? [...params.taggedErrors].sort().join("\u001f") : ""}`,
  ].join("\u001e")

/**
 * Error thrown when a source step is not found in the step map.
 */
export class SourceStepNotFound extends Data.TaggedError("SourceStepNotFound")<{
  readonly stepPath: string
}> {}

/**
 * Error thrown when a target step is not found in the step map.
 */
export class TargetStepNotFound extends Data.TaggedError("TargetStepNotFound")<{
  readonly stepPath: string
}> {}

/**
 * Error thrown when an org unit PK is not found in the global map.
 * This should never happen if Pass 1 completed successfully.
 */
export class OrgUnitPkNotFound extends Data.TaggedError("OrgUnitPkNotFound")<{
  readonly path: string
}> {}

/**
 * Error thrown when an invitation references a role that doesn't exist.
 */
export class InvitationRoleNotFound extends Data.TaggedError(
  "InvitationRoleNotFound",
)<{
  readonly invitationId: string
  readonly rolePath: string
}> {}

/**
 * Stores an organisation and all its processes, steps, flows, and roles in the database.
 *
 * This function uses a three-pass approach for efficiency:
 * 1. Pass 1: Upsert all org units and roles, building a global role path→PK map
 * 2. Pass 2: Upsert all processes, steps, and flows using the global role map
 * 3. Pass 3: Upsert OAuth provider configurations
 * 4. Delete orphaned records not in the current structure
 *
 * The two-pass approach enables roles defined at any org unit level (including the root organisation)
 * to be referenced by steps in child org units, which is a common pattern where org-level roles
 * (like "Employee") are used by processes in departmental org units.
 *
 * All operations are wrapped in a database transaction for atomicity.
 *
 * This is a database-agnostic implementation. Provide a database-specific DbOperations
 * implementation layer (from @pf/postgres-operations or @pf/sqlite-operations)
 * along with the corresponding SqlClient layer.
 *
 * @param org - Organisation to store
 * @returns Effect that succeeds with void or fails with SqlError (from database),
 *          SourceStepNotFound, TargetStepNotFound, OrgUnitPkNotFound,
 *          InvitationRoleNotFound, or FlowCrossProcessError
 *
 * @example
 * ```typescript
 * import { storeOrganisation } from "@pf/org-to-db"
 * import { SqliteDbOperationsLive } from "@pf/sqlite-operations"
 * import { TypedSqliteDrizzleLayer } from "@pf/service-drizzle-sqlite"
 * import { Organisation, Process, Step, Role } from "@pf/process"
 * import { Effect, Layer } from "effect"
 * import { TursoLive } from "@pf/layer-turso-local"
 *
 * const org = new Organisation({ name: "My Org" })
 * const role = new Role(org, "admin")
 * const process = new Process(org, "onboarding", {
 *   name: "Onboarding",
 *   purpose: "Onboard new employees"
 * })
 * new Step(process, "welcome", { role, name: "Send Welcome Email" })
 *
 * const DatabaseLayer = TypedSqliteDrizzleLayer.pipe(
 *   Layer.provideMerge(TursoLive)
 * )
 * const AppLayer = SqliteDbOperationsLive.pipe(
 *   Layer.provideMerge(DatabaseLayer)
 * )
 *
 * await Effect.runPromise(
 *   storeOrganisation(org).pipe(Effect.provide(AppLayer))
 * )
 * ```
 */
/**
 * Pass 1: Recursively upserts all org units and roles in the hierarchy.
 * Builds global maps for role path -> PK and org unit path -> PK.
 *
 * Note: This pass cannot fail with business logic errors (like RoleNotFound)
 * because it only inserts data without cross-references. All failures are
 * database errors (SqlError).
 *
 * @param orgUnitData - The org unit to process (with its roles and children)
 * @param dbOps - Database operations service
 * @param parentOrgUnitId - Optional parent org unit database PK
 * @param rolePathToPkRef - Ref containing global map of role path to database PK
 * @param orgUnitPathToPkRef - Ref containing global map of org unit path to database PK
 * @param pathRefs - Refs for collecting all entity paths for orphan deletion
 * @returns Effect that populates the global maps
 */
const upsertOrgUnitsAndRoles: <R>(
  orgUnitData: ExtractedOrgUnitData,
  dbOps: DbOperationsService<R>,
  parentOrgUnitId: string | undefined,
  rolePathToPkRef: Ref.Ref<HashMap.HashMap<string, string>>,
  orgUnitPathToPkRef: Ref.Ref<HashMap.HashMap<string, string>>,
  pathRefs: {
    orgUnits: Ref.Ref<ReadonlyArray<string>>
    roles: Ref.Ref<ReadonlyArray<string>>
  },
) => Effect.Effect<void, SqlError, R> = Effect.fn(
  "OrgToDb.upsertOrgUnitsAndRoles",
)(
  function* (
    orgUnitData,
    dbOps,
    parentOrgUnitId,
    rolePathToPkRef,
    orgUnitPathToPkRef,
    pathRefs,
  ) {
    // Upsert the org unit and get its database PK
    const orgUnitId = yield* dbOps.upsertOrgUnit(
      {
        name: orgUnitData.name,
        orgUnitLevel: orgUnitData.orgUnitLevel,
        path: orgUnitData.path,
        parentOrgUnitPath: orgUnitData.parentOrgUnitPath,
        acronym: orgUnitData.acronym,
        timezone: orgUnitData.timezone,
      },
      parentOrgUnitId,
    )

    // Store in global map and paths using Ref
    yield* Ref.update(orgUnitPathToPkRef, (map) =>
      HashMap.set(map, orgUnitData.path, orgUnitId),
    )
    yield* Ref.update(pathRefs.orgUnits, (paths) => [
      ...paths,
      orgUnitData.path,
    ])

    // Upsert all roles for this org unit and add to global maps
    yield* Effect.forEach(
      orgUnitData.roles,
      (role) =>
        Effect.gen(function* () {
          const roleId = yield* dbOps.upsertRole(role, orgUnitId)
          yield* Ref.update(rolePathToPkRef, (map) =>
            HashMap.set(map, role.path, roleId),
          )
          yield* Ref.update(pathRefs.roles, (paths) => [...paths, role.path])
        }),
      { concurrency: 1 },
    )

    // Recursively process child org units
    yield* Effect.forEach(
      orgUnitData.children,
      (child) =>
        upsertOrgUnitsAndRoles(
          child,
          dbOps,
          orgUnitId,
          rolePathToPkRef,
          orgUnitPathToPkRef,
          pathRefs,
        ),
      { concurrency: 1 },
    )
  },
)

/**
 * Pass 2: Recursively upserts all processes, phases, steps, flows, and responsibilities.
 * Phases are now process-specific and upserted with each process.
 *
 * @param orgUnitData - The org unit to process (with its processes and children)
 * @param dbOps - Database operations service
 * @param orgUnitPathToPkRef - Ref containing global map of org unit path to database PK
 * @param rolePathToPkRef - Ref containing global map of role path to database PK
 * @param pathRefs - Refs for collecting all entity paths for orphan deletion
 * @returns Effect that upserts processes, phases, steps, flows, and responsibilities
 */
const upsertProcessesStepsFlowsAndResponsibilities: <R>(
  orgUnitData: ExtractedOrgUnitData,
  dbOps: DbOperationsService<R>,
  orgUnitPathToPkRef: Ref.Ref<HashMap.HashMap<string, string>>,
  rolePathToPkRef: Ref.Ref<HashMap.HashMap<string, string>>,
  pathRefs: {
    processes: Ref.Ref<ReadonlyArray<string>>
    phases: Ref.Ref<ReadonlyArray<string>>
    steps: Ref.Ref<ReadonlyArray<string>>
    flows: Ref.Ref<ReadonlyArray<string>>
    responsibilities: Ref.Ref<ReadonlyArray<RoleResponsibilityKey>>
  },
  // Global refs for step-document-store junction (populated across all processes)
  globalStepPathToPkRef: Ref.Ref<HashMap.HashMap<string, string>>,
) => Effect.Effect<
  void,
  | SourceStepNotFound
  | TargetStepNotFound
  | OrgUnitPkNotFound
  | FlowCrossProcessError
  | SqlError,
  R
> = Effect.fn("OrgToDb.upsertProcessesStepsFlowsAndResponsibilities")(
  function* (
    orgUnitData,
    dbOps,
    orgUnitPathToPkRef,
    rolePathToPkRef,
    pathRefs,
    globalStepPathToPkRef,
  ) {
    // Get org unit PK from global map
    const orgUnitPathToPkMap = yield* Ref.get(orgUnitPathToPkRef)
    const orgUnitIdOption = HashMap.get(orgUnitPathToPkMap, orgUnitData.path)
    if (Option.isNone(orgUnitIdOption)) {
      // This should never happen since Pass 1 populates the map
      return yield* new OrgUnitPkNotFound({ path: orgUnitData.path })
    }

    const orgUnitPk = orgUnitIdOption.value

    // Get the global role map for lookups
    const rolePathToPkMap = yield* Ref.get(rolePathToPkRef)

    // Upsert all processes for this org unit
    yield* Effect.forEach(
      orgUnitData.processes,
      (process) =>
        Effect.gen(function* () {
          // Upsert process and get its PK
          const processId = yield* dbOps.upsertProcess(
            {
              orgUnitPath: process.orgUnitPath,
              name: process.name,
              path: process.path,
              purpose: process.purpose,
              ...(process.sla && { sla: process.sla }),
            },
            orgUnitPk,
          )
          yield* Ref.update(pathRefs.processes, (paths) => [
            ...paths,
            process.path,
          ])

          // Build phase path->PK map for this process (local to this process)
          const phasePathToPkMap = new Map<string, string>()

          // Upsert all phases for this process first (before steps need them)
          yield* Effect.forEach(
            process.phases,
            (phase) =>
              Effect.gen(function* () {
                const phaseId = yield* dbOps.upsertPhase(phase, processId)
                phasePathToPkMap.set(phase.path, phaseId)
                yield* Ref.update(pathRefs.phases, (paths) => [
                  ...paths,
                  phase.path,
                ])
              }),
            { concurrency: 1 },
          )

          // Build step path->PK map for this process (local to this process)
          const stepPathToPkRef = yield* Ref.make(
            HashMap.empty<string, string>(),
          )

          // Upsert all steps for this process
          yield* Effect.forEach(
            process.steps,
            (step) =>
              Effect.gen(function* () {
                // Resolve phase path to phaseId if present
                let phaseId: string | undefined
                if (step.phasePath) {
                  phaseId = phasePathToPkMap.get(step.phasePath)
                }

                const stepId = yield* dbOps.upsertStep(step, processId, phaseId)
                yield* Ref.update(stepPathToPkRef, (map) =>
                  HashMap.set(map, step.path, stepId),
                )
                // Also populate the global ref for step-document-store junction
                yield* Ref.update(globalStepPathToPkRef, (map) =>
                  HashMap.set(map, step.path, stepId),
                )
                yield* Ref.update(pathRefs.steps, (paths) => [
                  ...paths,
                  step.path,
                ])
              }),
            { concurrency: 1 },
          )

          // Upsert all flows for this process
          const flowKeyCounts = new Map<string, number>()
          yield* Effect.forEach(
            process.flows,
            (flow) =>
              Effect.gen(function* () {
                const stepPathToPkMap = yield* Ref.get(stepPathToPkRef)

                const sourceStepIdOption = HashMap.get(
                  stepPathToPkMap,
                  flow.sourceStepPath,
                )
                if (Option.isNone(sourceStepIdOption)) {
                  return yield* new SourceStepNotFound({
                    stepPath: flow.sourceStepPath,
                  })
                }

                const targetStepIdOption = HashMap.get(
                  stepPathToPkMap,
                  flow.targetStepPath,
                )
                if (Option.isNone(targetStepIdOption)) {
                  return yield* new TargetStepNotFound({
                    stepPath: flow.targetStepPath,
                  })
                }

                const fingerprint = buildFlowFingerprint({
                  sourceStepPath: flow.sourceStepPath,
                  targetStepPath: flow.targetStepPath,
                  isElse: flow.isElse,
                  isOnError: flow.isOnError,
                  taggedErrors: flow.taggedErrors,
                })
                const occurrence = flowKeyCounts.get(fingerprint) ?? 0
                flowKeyCounts.set(fingerprint, occurrence + 1)
                const flowKey = `${createHash("sha256").update(fingerprint).digest("hex")}:${occurrence}`

                yield* dbOps.upsertFlow(
                  flowKey,
                  flow,
                  sourceStepIdOption.value,
                  targetStepIdOption.value,
                )
                yield* Ref.update(pathRefs.flows, (paths) => [
                  ...paths,
                  flowKey,
                ])
              }),
            { concurrency: 1 },
          )

          // Upsert role responsibilities for this process
          yield* Effect.forEach(
            process.responsibilities,
            (responsibility) =>
              Effect.gen(function* () {
                const roleIdOption = HashMap.get(
                  rolePathToPkMap,
                  responsibility.rolePath,
                )
                // Skip if role not found (shouldn't happen if Pass 1 ran correctly)
                if (Option.isNone(roleIdOption)) {
                  return
                }

                yield* dbOps.upsertRoleResponsibility(
                  responsibility,
                  processId,
                  roleIdOption.value,
                )
                yield* Ref.update(pathRefs.responsibilities, (paths) => [
                  ...paths,
                  {
                    processPath: process.path,
                    rolePath: responsibility.rolePath,
                  },
                ])
              }),
            { concurrency: 1 },
          )
        }),
      { concurrency: 1 },
    )

    // Recursively process child org units
    yield* Effect.forEach(
      orgUnitData.children,
      (child) =>
        upsertProcessesStepsFlowsAndResponsibilities(
          child,
          dbOps,
          orgUnitPathToPkRef,
          rolePathToPkRef,
          pathRefs,
          globalStepPathToPkRef,
        ),
      { concurrency: 1 },
    )
  },
)

export const storeOrganisation = (
  org: Organisation,
): Effect.Effect<
  void,
  | SqlError
  | SourceStepNotFound
  | TargetStepNotFound
  | OrgUnitPkNotFound
  | InvitationRoleNotFound
  | FlowCrossProcessError,
  SqlClient.SqlClient | DbOperations
> =>
  Effect.gen(function* () {
    // Extract organisation data in hierarchical structure
    const orgData = yield* walkOrganisation(org)

    // Get required services
    const sql = yield* SqlClient.SqlClient
    const dbOps = yield* DbOperations

    const persistOrganisation = Effect.gen(function* () {
      // Create Refs per attempt so a rolled-back transaction retry starts clean.
      const rolePathToPkRef = yield* Ref.make(HashMap.empty<string, string>())
      const orgUnitPathToPkRef = yield* Ref.make(
        HashMap.empty<string, string>(),
      )

      // Create Refs for collecting all entity paths for orphan deletion
      const orgUnitPathsRef = yield* Ref.make<ReadonlyArray<string>>([])
      const rolePathsRef = yield* Ref.make<ReadonlyArray<string>>([])
      const phasePathsRef = yield* Ref.make<ReadonlyArray<string>>([])
      const processPathsRef = yield* Ref.make<ReadonlyArray<string>>([])
      const stepPathsRef = yield* Ref.make<ReadonlyArray<string>>([])
      const flowPathsRef = yield* Ref.make<ReadonlyArray<string>>([])
      const responsibilityPathsRef = yield* Ref.make<
        ReadonlyArray<RoleResponsibilityKey>
      >([])

      // Refs for step-document-store junction table tracking
      // These need to be global since steps and document stores are processed in different passes
      const stepPathToPkRef = yield* Ref.make(HashMap.empty<string, string>())
      const documentStorePathToPkRef = yield* Ref.make(
        HashMap.empty<string, string>(),
      )

      // Perform all operations in a transaction
      yield* sql.withTransaction(
        Effect.gen(function* () {
          // Pass 1: Upsert all org units and roles, build global maps
          yield* upsertOrgUnitsAndRoles(
            orgData.rootOrgUnit,
            dbOps,
            undefined,
            rolePathToPkRef,
            orgUnitPathToPkRef,
            {
              orgUnits: orgUnitPathsRef,
              roles: rolePathsRef,
            },
          )

          // Pass 2: Upsert all processes, phases, steps, flows, and responsibilities
          yield* upsertProcessesStepsFlowsAndResponsibilities(
            orgData.rootOrgUnit,
            dbOps,
            orgUnitPathToPkRef,
            rolePathToPkRef,
            {
              processes: processPathsRef,
              phases: phasePathsRef,
              steps: stepPathsRef,
              flows: flowPathsRef,
              responsibilities: responsibilityPathsRef,
            },
            stepPathToPkRef,
          )

          // Pass 3: Upsert OAuth provider configurations
          const authConfig = walkAuthenticationConfig(org)
          const providerNamesRef = yield* Ref.make<ReadonlyArray<string>>([])
          yield* Effect.forEach(
            authConfig.identityProviders,
            (provider) =>
              Effect.gen(function* () {
                // Persist the global auth flag into each provider row because OAuth
                // provider config is the runtime lookup unit today. Re-hydration is
                // the expected way to roll out inviteOnly changes.
                yield* dbOps.upsertOAuthProvider(provider.name, {
                  ...(provider.config as unknown as Record<string, unknown>),
                  inviteOnly: authConfig.inviteOnly,
                  delegatedAccess: authConfig.delegatedAccess,
                })
                yield* Ref.update(providerNamesRef, (names) => [
                  ...names,
                  provider.name,
                ])
              }),
            { concurrency: 1 },
          )

          // Upsert passkey provider configuration if present
          if (authConfig.passkey) {
            let passkeyConfig = authConfig.passkey as unknown as Record<
              string,
              unknown
            >

            const issuerUrl = process.env["OAUTH_ISSUER_URL"]
            if (issuerUrl) {
              const url = new URL(issuerUrl)
              passkeyConfig = {
                ...passkeyConfig,
                rpID: url.hostname,
                origin: issuerUrl,
              }
            }

            passkeyConfig = {
              ...passkeyConfig,
              inviteOnly: authConfig.inviteOnly,
              delegatedAccess: authConfig.delegatedAccess,
            }

            yield* dbOps.upsertOAuthProvider("passkey", passkeyConfig)
            yield* Ref.update(providerNamesRef, (names) => [
              ...names,
              "passkey",
            ])
          }

          // Pass 4: Upsert invitations with their roles
          const invitations = walkInvitations(org)
          const invitationIdsRef = yield* Ref.make<ReadonlyArray<string>>([])
          const rolePathToPkMap = yield* Ref.get(rolePathToPkRef)

          yield* Effect.forEach(
            invitations,
            (invitation) =>
              Effect.gen(function* () {
                // Resolve role paths to role PKs
                const roleIds: string[] = []
                for (const rolePath of invitation.rolePaths) {
                  const roleIdOption = HashMap.get(rolePathToPkMap, rolePath)
                  if (Option.isNone(roleIdOption)) {
                    return yield* new InvitationRoleNotFound({
                      invitationId: invitation.id,
                      rolePath,
                    })
                  }
                  roleIds.push(roleIdOption.value)
                }

                yield* dbOps.upsertInvitation(
                  {
                    id: invitation.id,
                    email: invitation.email,
                  },
                  roleIds,
                )
                yield* Ref.update(invitationIdsRef, (ids) => [
                  ...ids,
                  invitation.id,
                ])
              }),
            { concurrency: 1 },
          )

          // Pass 5: Upsert OAuth clients for M2M authentication
          // Filter out clients with empty secrets (not configured in env)
          const secretClients = walkSecretClients(org).filter(
            (client) => client.secret.length > 0,
          )
          const clientIdsRef = yield* Ref.make<ReadonlyArray<string>>([])

          yield* Effect.forEach(
            secretClients,
            (client) =>
              Effect.gen(function* () {
                // Hash the secret using Argon2id before storing
                const secretHash = yield* hashSecret(client.secret)
                yield* dbOps.upsertOAuthClient(
                  client.clientId,
                  secretHash,
                  client.audience,
                )
                yield* Ref.update(clientIdsRef, (ids) => [
                  ...ids,
                  client.clientId,
                ])
              }),
            { concurrency: 1 },
          )

          // Pass 6: Upsert business calendar data (weekly schedules and holiday rules)
          // Get root org unit PK for calendar data
          const orgUnitPathToPkMap = yield* Ref.get(orgUnitPathToPkRef)
          const rootOrgUnitId = Option.getOrUndefined(
            HashMap.get(orgUnitPathToPkMap, orgData.rootOrgUnit.path),
          )

          // Track calendar entries for orphan deletion
          const weeklyScheduleKeys: WeeklyScheduleKey[] = []
          const holidayRuleKeys: HolidayRuleKey[] = []

          if (rootOrgUnitId) {
            // Upsert weekly schedule entries
            yield* Effect.forEach(
              orgData.weeklySchedule,
              (schedule) =>
                Effect.gen(function* () {
                  yield* dbOps.upsertWeeklySchedule(schedule, rootOrgUnitId)
                  weeklyScheduleKeys.push({
                    orgUnitPath: schedule.orgUnitPath,
                    dayOfWeek: schedule.dayOfWeek,
                  })
                }),
              { concurrency: 1 },
            )

            // Upsert holiday rules
            yield* Effect.forEach(
              orgData.holidayRules,
              (holiday) =>
                Effect.gen(function* () {
                  yield* dbOps.upsertHolidayRule(holiday, rootOrgUnitId)
                  holidayRuleKeys.push({
                    orgUnitPath: holiday.orgUnitPath,
                    holidayTitle: holiday.name,
                  })
                }),
              { concurrency: 1 },
            )
          }

          // Pass 7: Upsert document stores
          const documentStores = walkDocumentStores(org)
          const documentStorePathsRef = yield* Ref.make<ReadonlyArray<string>>(
            [],
          )

          yield* Effect.forEach(
            documentStores,
            (store) =>
              Effect.gen(function* () {
                const orgUnitIdOption = HashMap.get(
                  orgUnitPathToPkMap,
                  store.orgUnitPath,
                )
                if (Option.isNone(orgUnitIdOption)) {
                  return yield* new OrgUnitPkNotFound({
                    path: store.orgUnitPath,
                  })
                }

                const storeId = yield* dbOps.upsertDocumentStore(
                  store,
                  orgUnitIdOption.value,
                )
                yield* Ref.update(documentStorePathsRef, (paths) => [
                  ...paths,
                  store.path,
                ])
                yield* Ref.update(documentStorePathToPkRef, (map) =>
                  HashMap.set(map, store.path, storeId),
                )
              }),
            { concurrency: 1 },
          )

          // Pass 8: Create step-document-store junction entries
          // This links steps to the document stores they reference (for authorization)
          const stepDocumentStoreKeysRef = yield* Ref.make<
            ReadonlyArray<StepDocumentStoreKey>
          >([])
          const stepPathToPkMap = yield* Ref.get(stepPathToPkRef)
          const documentStorePathToPkMap = yield* Ref.get(
            documentStorePathToPkRef,
          )

          // Walk through all org units and their processes to find steps with document store references
          for (const orgUnit of [
            orgData.rootOrgUnit,
            ...getAllDescendantOrgUnits(orgData.rootOrgUnit),
          ]) {
            for (const process of orgUnit.processes) {
              for (const step of process.steps) {
                if (
                  step.documentStoreReferences &&
                  step.documentStoreReferences.length > 0
                ) {
                  const stepIdOption = HashMap.get(stepPathToPkMap, step.path)
                  if (Option.isSome(stepIdOption)) {
                    const stepId = stepIdOption.value
                    for (const storePath of step.documentStoreReferences) {
                      const storeIdOption = HashMap.get(
                        documentStorePathToPkMap,
                        storePath,
                      )
                      if (Option.isSome(storeIdOption)) {
                        const storeId = storeIdOption.value
                        yield* dbOps.upsertStepDocumentStore(stepId, storeId)
                        yield* Ref.update(stepDocumentStoreKeysRef, (keys) => [
                          ...keys,
                          {
                            stepPath: step.path,
                            documentStorePath: storePath,
                          },
                        ])
                      }
                    }
                  }
                }
              }
            }
          }

          // Get final path arrays from Refs for orphan deletion
          const flowPaths = yield* Ref.get(flowPathsRef)
          const stepPaths = yield* Ref.get(stepPathsRef)
          const rolePaths = yield* Ref.get(rolePathsRef)
          const phasePaths = yield* Ref.get(phasePathsRef)
          const processPaths = yield* Ref.get(processPathsRef)
          const orgUnitPaths = yield* Ref.get(orgUnitPathsRef)
          const responsibilityPaths = yield* Ref.get(responsibilityPathsRef)
          const stepDocumentStoreKeys = yield* Ref.get(stepDocumentStoreKeysRef)
          const documentStorePaths = yield* Ref.get(documentStorePathsRef)
          const providerNames = yield* Ref.get(providerNamesRef)
          const clientIds = yield* Ref.get(clientIdsRef)
          const invitationIds = yield* Ref.get(invitationIdsRef)

          // Delete orphaned records (entities not in current structure)
          // Order matters: dependent records must be deleted before their parents
          yield* dbOps.deleteOrphanedStepDocumentStores([
            ...stepDocumentStoreKeys,
          ])
          yield* dbOps.deleteOrphanedFlows([...flowPaths])
          yield* dbOps.deleteOrphanedRoleResponsibilities([
            ...responsibilityPaths,
          ])
          yield* dbOps.deleteOrphanedSteps([...stepPaths])
          yield* dbOps.deleteOrphanedRoles([...rolePaths])
          yield* dbOps.deleteOrphanedPhases([...phasePaths])
          yield* dbOps.deleteOrphanedProcesses([...processPaths])
          yield* dbOps.deleteOrphanedWeeklySchedules(weeklyScheduleKeys)
          yield* dbOps.deleteOrphanedHolidayRules(holidayRuleKeys)
          yield* dbOps.deleteOrphanedDocumentStores([...documentStorePaths])
          yield* dbOps.deleteOrphanedOrgUnits([...orgUnitPaths])
          yield* dbOps.deleteOrphanedOAuthProviders([...providerNames])

          yield* dbOps.deleteOrphanedOAuthClients([...clientIds])
          // Pending model-owned invitations only. Accepted history and
          // dashboard/process/legacy sources are not model orphans.
          yield* dbOps.deleteOrphanedInvitations([...invitationIds])
        }),
      )
    })

    yield* persistOrganisation.pipe(
      // Log each observed transient 502 before the retry helper either retries
      // this attempt or returns the failure to the caller.
      Effect.tapError((error) =>
        isTransientTursoServerError(error)
          ? Effect.logWarning(
              "Transient Turso HTTP 502 during org import transaction attempt",
            )
          : Effect.void,
      ),
      retryTransientTursoServerError,
    )
  })
