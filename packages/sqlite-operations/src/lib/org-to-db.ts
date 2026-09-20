import { strict as assert } from "node:assert"
import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  like,
  ne,
  notInArray,
  sql,
} from "drizzle-orm"
import { Effect, Layer } from "effect"
import * as schema from "@pf/drizzle-sqlite"
import { returnedRow } from "@pf/graphql-db-operations"
import {
  DbOperations,
  FlowCrossProcessError,
} from "@pf/org-to-db/db-operations"
import { getRequestTime } from "@pf/request-time"
import { TypedSqliteDrizzle } from "@pf/service-drizzle-sqlite"

/**
 * Live implementation of the SQLite database operations service.
 *
 * This layer provides all database operations for storing organisation structures
 * in SQLite using Drizzle ORM.
 *
 * All operations require TypedSqliteDrizzle and should be called within a transaction.
 * Operations can fail with SqlError from database errors.
 */
export const SqliteDbOperationsLive = Layer.succeed(DbOperations, {
  upsertOrgUnit: (orgUnit, parentOrgUnitId) =>
    Effect.gen(function* () {
      const db = yield* TypedSqliteDrizzle
      const requestTime = yield* getRequestTime()

      const result = yield* db
        .insert(schema.orgUnit)
        .values({
          name: orgUnit.name,
          orgUnitLevel: orgUnit.orgUnitLevel,
          path: orgUnit.path,
          parentOrgUnitId: parentOrgUnitId ?? null,
          acronym: orgUnit.acronym ?? null,
          timezone: orgUnit.timezone,
          startDayOfWeek: orgUnit.startDayOfWeek ?? null,
          createdAt: requestTime,
          updatedAt: requestTime,
        })
        .onConflictDoUpdate({
          target: schema.orgUnit.path,
          targetWhere: sql`_deleted = 0`,
          set: {
            name: orgUnit.name,
            orgUnitLevel: orgUnit.orgUnitLevel,
            parentOrgUnitId: parentOrgUnitId ?? null,
            acronym: orgUnit.acronym ?? null,
            timezone: orgUnit.timezone,
            startDayOfWeek: orgUnit.startDayOfWeek ?? null,
            updatedAt: requestTime,
          },
        })
        .returning({ id: schema.orgUnit.id })

      return (yield* returnedRow(result)).id
    }),

  upsertProcess: (process, orgUnitId) =>
    Effect.gen(function* () {
      const db = yield* TypedSqliteDrizzle
      const requestTime = yield* getRequestTime()

      const slaValue = process.sla?.value ?? null
      const slaUnit = process.sla?.unit ?? null
      const slaWarning = process.sla?.warningAt ?? null

      const result = yield* db
        .insert(schema.process)
        .values({
          orgUnitId,
          name: process.name,
          path: process.path,
          purpose: process.purpose,
          slaValue,
          slaUnit,
          slaWarning,
          createdAt: requestTime,
          updatedAt: requestTime,
        })
        .onConflictDoUpdate({
          target: schema.process.path,
          targetWhere: sql`_deleted = 0`,
          set: {
            name: process.name,
            purpose: process.purpose,
            orgUnitId,
            slaValue,
            slaUnit,
            slaWarning,
            updatedAt: requestTime,
          },
        })
        .returning({ id: schema.process.id })

      return (yield* returnedRow(result)).id
    }),

  upsertRole: (role, orgUnitId) =>
    Effect.gen(function* () {
      const db = yield* TypedSqliteDrizzle
      const requestTime = yield* getRequestTime()

      const result = yield* db
        .insert(schema.role)
        .values({
          orgUnitId,
          name: role.name,
          path: role.path,
          createdAt: requestTime,
          updatedAt: requestTime,
        })
        .onConflictDoUpdate({
          target: schema.role.path,
          targetWhere: sql`_deleted = 0`,
          set: {
            name: role.name,
            orgUnitId,
            _deleted: false,
            updatedAt: requestTime,
          },
        })
        .returning({ id: schema.role.id })

      return (yield* returnedRow(result)).id
    }),

  upsertPhase: (phase, processId) =>
    Effect.gen(function* () {
      const db = yield* TypedSqliteDrizzle
      const requestTime = yield* getRequestTime()

      const result = yield* db
        .insert(schema.phase)
        .values({
          processId,
          name: phase.name,
          path: phase.path,
          phaseOrder: phase.order,
          createdAt: requestTime,
          updatedAt: requestTime,
        })
        .onConflictDoUpdate({
          target: schema.phase.path,
          targetWhere: sql`_deleted = 0`,
          set: {
            name: phase.name,
            processId,
            phaseOrder: phase.order,
            _deleted: false,
            updatedAt: requestTime,
          },
        })
        .returning({ id: schema.phase.id })

      return (yield* returnedRow(result)).id
    }),

  upsertStep: (step, processId, phaseId) =>
    Effect.gen(function* () {
      const db = yield* TypedSqliteDrizzle
      const requestTime = yield* getRequestTime()

      // Look up role by path to get its database ID (if step has a role)
      // System steps (SystemStep) have no role - roleId will be null
      let roleId: string | null = null
      if (step.rolePath) {
        const roleResult = yield* db
          .select({ id: schema.role.id })
          .from(schema.role)
          .where(eq(schema.role.path, step.rolePath))
          .limit(1)

        assert(roleResult[0], `Role not found for path: ${step.rolePath}`)
        roleId = roleResult[0].id
      }

      const formFields = step.formFields ?? null
      const slaValue = step.sla?.value ?? null
      const slaUnit = step.sla?.unit ?? null
      const slaWarning = step.sla?.warningAt ?? null
      const hasForEach = step.hasForEach ?? false
      const embedded = step.embedded ?? false
      const retryLimit = step.retryLimit ?? null

      const result = yield* db
        .insert(schema.step)
        .values({
          name: step.name,
          purpose: step.purpose,
          processId,
          roleId,
          formFields,
          phaseId: phaseId ?? null,
          path: step.path,
          slaValue,
          slaUnit,
          slaWarning,
          hasForEach,
          embedded,
          retryLimit,
          createdAt: requestTime,
          updatedAt: requestTime,
        })
        .onConflictDoUpdate({
          target: schema.step.path,
          targetWhere: sql`_deleted = 0`,
          set: {
            name: step.name,
            purpose: step.purpose,
            processId,
            roleId,
            formFields,
            phaseId: phaseId ?? null,
            slaValue,
            slaUnit,
            slaWarning,
            hasForEach,
            embedded,
            retryLimit,
            _deleted: false,
            updatedAt: requestTime,
          },
        })
        .returning({ id: schema.step.id })

      const stepId = (yield* returnedRow(result)).id

      // Sync supporting roles for this step (only when explicitly declared)
      if (step.supportingRolePaths !== undefined) {
        // Soft-delete existing supporting roles
        yield* db
          .update(schema.stepSupportingRole)
          .set({ _deleted: true, updatedAt: requestTime })
          .where(
            and(
              eq(schema.stepSupportingRole.stepId, stepId),
              eq(schema.stepSupportingRole._deleted, false),
            ),
          )

        // Upsert current supporting roles
        for (const rolePath of step.supportingRolePaths) {
          const supportingRoleResult = yield* db
            .select({ id: schema.role.id })
            .from(schema.role)
            .where(eq(schema.role.path, rolePath))
            .limit(1)

          assert(
            supportingRoleResult[0],
            `Supporting role not found for path: ${rolePath}`,
          )

          yield* db
            .insert(schema.stepSupportingRole)
            .values({
              stepId,
              roleId: supportingRoleResult[0].id,
              createdAt: requestTime,
              updatedAt: requestTime,
            })
            .onConflictDoUpdate({
              target: [
                schema.stepSupportingRole.stepId,
                schema.stepSupportingRole.roleId,
              ],
              targetWhere: sql`_deleted = 0`,
              set: {
                _deleted: false,
                updatedAt: requestTime,
              },
            })
        }
      }

      return stepId
    }),

  upsertRoleResponsibility: (responsibility, processId, roleId) =>
    Effect.gen(function* () {
      const db = yield* TypedSqliteDrizzle
      const requestTime = yield* getRequestTime()

      yield* db
        .insert(schema.roleResponsibility)
        .values({
          processId,
          roleId,
          responsibility: responsibility.responsibility,
          responsibilityOrder: responsibility.order,
          createdAt: requestTime,
          updatedAt: requestTime,
        })
        .onConflictDoUpdate({
          target: [
            schema.roleResponsibility.processId,
            schema.roleResponsibility.roleId,
          ],
          targetWhere: sql`_deleted = 0`,
          set: {
            responsibility: responsibility.responsibility,
            responsibilityOrder: responsibility.order,
            _deleted: false,
            updatedAt: requestTime,
          },
        })
    }),

  // NOTE: SQLite uses onConflictDoUpdate instead of onConflictDoNothing due to a SQLite/Drizzle
  // limitation - onConflictDoNothing does not support targetWhere in SQLite.
  // PostgreSQL can use onConflictDoNothing with targetWhere.
  // We set updatedAt and _deleted to maintain the conflict resolution behavior while working around this limitation.
  upsertFlow: (flowKey, flow, sourceStepId, targetStepId) =>
    Effect.gen(function* () {
      const db = yield* TypedSqliteDrizzle
      const requestTime = yield* getRequestTime()
      // taggedErrors behave like a set for flow identity and persistence.
      const normalizedTaggedErrors = flow.taggedErrors
        ? [...flow.taggedErrors].sort()
        : null

      // Validate that both steps belong to the same process
      const steps = yield* db
        .select({ id: schema.step.id, processId: schema.step.processId })
        .from(schema.step)
        .where(inArray(schema.step.id, [sourceStepId, targetStepId]))

      const sourceStep = steps.find((s) => s.id === sourceStepId)
      const targetStep = steps.find((s) => s.id === targetStepId)

      assert(sourceStep, `Source step not found: ${sourceStepId}`)
      assert(targetStep, `Target step not found: ${targetStepId}`)

      if (sourceStep.processId !== targetStep.processId) {
        return yield* new FlowCrossProcessError({
          sourceStepId,
          targetStepId,
          sourceProcessId: sourceStep.processId,
          targetProcessId: targetStep.processId,
        })
      }

      const existingFlow = yield* db
        .select({ id: schema.flow.id })
        .from(schema.flow)
        .where(
          and(
            eq(schema.flow.flowKey, flowKey),
            eq(schema.flow._deleted, false),
          ),
        )
        .limit(1)

      const flowToUpdate =
        existingFlow[0] ??
        (yield* db
          .select({ id: schema.flow.id })
          .from(schema.flow)
          .where(
            and(
              eq(schema.flow.sourceStepId, sourceStepId),
              eq(schema.flow.targetStepId, targetStepId),
              flow.condition === undefined
                ? isNull(schema.flow.condition)
                : eq(schema.flow.condition, flow.condition),
              flow.schedule === undefined
                ? isNull(schema.flow.schedule)
                : eq(schema.flow.schedule, flow.schedule),
              eq(schema.flow.fallbackBranch, flow.isElse),
              eq(schema.flow.errorBranch, flow.isOnError ?? false),
              normalizedTaggedErrors === null
                ? isNull(schema.flow.errorTags)
                : eq(schema.flow.errorTags, normalizedTaggedErrors),
              eq(schema.flow._deleted, false),
              like(schema.flow.flowKey, "legacy:%"),
            ),
          )
          // The pre-flowKey schema enforced one active source/target pair, so
          // at most one legacy row can exist here during the upgrade window.
          .limit(1))[0]

      if (flowToUpdate) {
        yield* db
          .update(schema.flow)
          .set({
            flowKey,
            sourceStepId,
            targetStepId,
            condition: flow.condition ?? null,
            schedule: flow.schedule ?? null,
            fallbackBranch: flow.isElse,
            errorBranch: flow.isOnError ?? false,
            errorTags: normalizedTaggedErrors,
            _deleted: false,
            updatedAt: requestTime,
          })
          .where(eq(schema.flow.id, flowToUpdate.id))

        return
      }

      yield* db.insert(schema.flow).values({
        flowKey,
        sourceStepId,
        targetStepId,
        condition: flow.condition ?? null,
        schedule: flow.schedule ?? null,
        fallbackBranch: flow.isElse,
        errorBranch: flow.isOnError ?? false,
        errorTags: normalizedTaggedErrors,
        createdAt: requestTime,
        updatedAt: requestTime,
      })
    }),

  deleteOrphanedFlows: (currentFlowPaths: string[]) =>
    Effect.gen(function* () {
      const db = yield* TypedSqliteDrizzle
      const requestTime = yield* getRequestTime()

      if (currentFlowPaths.length === 0) {
        // Soft delete all flows
        yield* db
          .update(schema.flow)
          .set({ _deleted: true, updatedAt: requestTime })
        return
      }

      // Get all existing flows
      const existingFlows = yield* db
        .select({
          id: schema.flow.id,
          flowKey: schema.flow.flowKey,
        })
        .from(schema.flow)

      // Find flows to soft delete (those not in current list)
      const flowIdsToDelete = existingFlows
        .filter((flow) => !currentFlowPaths.includes(flow.flowKey))
        .map((flow) => flow.id)

      if (flowIdsToDelete.length > 0) {
        yield* db
          .update(schema.flow)
          .set({ _deleted: true, updatedAt: requestTime })
          .where(inArray(schema.flow.id, flowIdsToDelete))
      }
    }),

  deleteOrphanedSteps: (currentStepPaths: string[]) =>
    Effect.gen(function* () {
      const db = yield* TypedSqliteDrizzle
      const requestTime = yield* getRequestTime()

      if (currentStepPaths.length === 0) {
        // Soft delete all steps
        yield* db
          .update(schema.step)
          .set({ _deleted: true, updatedAt: requestTime })
      } else {
        // Soft delete steps not in current list
        yield* db
          .update(schema.step)
          .set({ _deleted: true, updatedAt: requestTime })
          .where(notInArray(schema.step.path, currentStepPaths))
      }
    }),

  deleteOrphanedRoles: (currentRolePaths: string[]) =>
    Effect.gen(function* () {
      const db = yield* TypedSqliteDrizzle
      const requestTime = yield* getRequestTime()

      if (currentRolePaths.length === 0) {
        // Soft delete all roles
        yield* db
          .update(schema.role)
          .set({ _deleted: true, updatedAt: requestTime })
      } else {
        // Soft delete roles not in current list
        yield* db
          .update(schema.role)
          .set({ _deleted: true, updatedAt: requestTime })
          .where(notInArray(schema.role.path, currentRolePaths))
      }
    }),

  deleteOrphanedProcesses: (currentProcessPaths: string[]) =>
    Effect.gen(function* () {
      const db = yield* TypedSqliteDrizzle
      const requestTime = yield* getRequestTime()

      if (currentProcessPaths.length === 0) {
        // Soft delete all processes
        yield* db
          .update(schema.process)
          .set({ _deleted: true, updatedAt: requestTime })
      } else {
        // Soft delete processes not in current list
        yield* db
          .update(schema.process)
          .set({ _deleted: true, updatedAt: requestTime })
          .where(notInArray(schema.process.path, currentProcessPaths))
      }
    }),

  deleteOrphanedOrgUnits: (currentOrgUnitPaths: string[]) =>
    Effect.gen(function* () {
      const db = yield* TypedSqliteDrizzle
      const requestTime = yield* getRequestTime()

      if (currentOrgUnitPaths.length === 0) {
        // Soft delete all org units
        yield* db
          .update(schema.orgUnit)
          .set({ _deleted: true, updatedAt: requestTime })
      } else {
        // Soft delete org units not in current list
        yield* db
          .update(schema.orgUnit)
          .set({ _deleted: true, updatedAt: requestTime })
          .where(notInArray(schema.orgUnit.path, currentOrgUnitPaths))
      }
    }),

  deleteOrphanedPhases: (currentPhasePaths: string[]) =>
    Effect.gen(function* () {
      const db = yield* TypedSqliteDrizzle
      const requestTime = yield* getRequestTime()

      if (currentPhasePaths.length === 0) {
        // Soft delete all phases
        yield* db
          .update(schema.phase)
          .set({ _deleted: true, updatedAt: requestTime })
      } else {
        // Soft delete phases not in current list
        yield* db
          .update(schema.phase)
          .set({ _deleted: true, updatedAt: requestTime })
          .where(notInArray(schema.phase.path, currentPhasePaths))
      }
    }),

  deleteOrphanedRoleResponsibilities: (currentKeys) =>
    Effect.gen(function* () {
      const db = yield* TypedSqliteDrizzle
      const requestTime = yield* getRequestTime()

      if (currentKeys.length === 0) {
        // Soft delete all role responsibilities
        yield* db
          .update(schema.roleResponsibility)
          .set({ _deleted: true, updatedAt: requestTime })
        return
      }

      // Build map of process path to database ID (only active processes)
      const processPathToIdMap = new Map<string, string>()
      const processes = yield* db
        .select({ id: schema.process.id, path: schema.process.path })
        .from(schema.process)
        .where(eq(schema.process._deleted, false))
      for (const p of processes) {
        processPathToIdMap.set(p.path, p.id)
      }

      // Build map of role path to database ID (only active roles)
      const rolePathToIdMap = new Map<string, string>()
      const roles = yield* db
        .select({ id: schema.role.id, path: schema.role.path })
        .from(schema.role)
        .where(eq(schema.role._deleted, false))
      for (const r of roles) {
        rolePathToIdMap.set(r.path, r.id)
      }

      // Convert pairs to (processId, roleId) tuples
      const currentPairIds = currentKeys
        .map(({ processPath, rolePath }) => {
          const processId = processPathToIdMap.get(processPath)
          const roleId = rolePathToIdMap.get(rolePath)
          return processId && roleId ? { processId, roleId } : null
        })
        .filter(
          (pair): pair is { processId: string; roleId: string } =>
            pair !== null,
        )

      // Get all existing role responsibilities
      const existingResponsibilities = yield* db
        .select({
          id: schema.roleResponsibility.id,
          processId: schema.roleResponsibility.processId,
          roleId: schema.roleResponsibility.roleId,
        })
        .from(schema.roleResponsibility)

      // Find responsibilities to soft delete (those not in current list)
      const respIdsToDelete = existingResponsibilities
        .filter(
          (resp) =>
            !currentPairIds.some(
              (pair) =>
                pair.processId === resp.processId &&
                pair.roleId === resp.roleId,
            ),
        )
        .map((resp) => resp.id)

      if (respIdsToDelete.length > 0) {
        yield* db
          .update(schema.roleResponsibility)
          .set({ _deleted: true, updatedAt: requestTime })
          .where(inArray(schema.roleResponsibility.id, respIdsToDelete))
      }
    }),

  upsertOAuthProvider: (providerName, config) =>
    Effect.gen(function* () {
      const db = yield* TypedSqliteDrizzle
      const requestTime = yield* getRequestTime()

      yield* db
        .insert(schema.oauthProvider)
        .values({
          providerName,
          providerConfig: config,
          createdAt: requestTime,
          updatedAt: requestTime,
        })
        .onConflictDoUpdate({
          target: schema.oauthProvider.providerName,
          targetWhere: sql`_deleted = 0`,
          set: {
            providerConfig: config,
            updatedAt: requestTime,
          },
        })
    }),

  deleteOrphanedOAuthProviders: (currentProviderNames: string[]) =>
    Effect.gen(function* () {
      const db = yield* TypedSqliteDrizzle
      const requestTime = yield* getRequestTime()

      if (currentProviderNames.length === 0) {
        // Soft delete all OAuth providers
        yield* db
          .update(schema.oauthProvider)
          .set({ _deleted: true, updatedAt: requestTime })
      } else {
        // Soft delete providers not in current list
        yield* db
          .update(schema.oauthProvider)
          .set({ _deleted: true, updatedAt: requestTime })
          .where(
            notInArray(schema.oauthProvider.providerName, currentProviderNames),
          )
      }
    }),

  upsertInvitation: (invitation, roleIds) =>
    Effect.gen(function* () {
      const db = yield* TypedSqliteDrizzle
      const requestTime = yield* getRequestTime()

      // Upsert the invitation (normalize email to lowercase for case-insensitive matching)
      const normalizedEmail = invitation.email.toLowerCase()

      // Accepted/legacy-closed authored invitations are immutable history.
      // Check this before soft-deleting sibling pending rows so rehydrate of an
      // accepted model invite cannot wipe a later dashboard/process re-invite.
      const existingByConstructId = yield* db
        .select({
          id: schema.invitation.id,
          email: schema.invitation.email,
          invitationStatus: schema.invitation.invitationStatus,
        })
        .from(schema.invitation)
        .where(
          and(
            eq(schema.invitation.invitationId, invitation.id),
            eq(schema.invitation._deleted, false),
          ),
        )
        .limit(1)
      const existingInvitation = existingByConstructId[0]
      if (
        existingInvitation &&
        existingInvitation.invitationStatus !== "pending"
      ) {
        return existingInvitation.id
      }

      // Live Registration Link authority cleared on soft-delete and when the
      // pending grant's email or roles change during model hydration.
      const clearRegistrationLinkOnHydrate = {
        registrationTokenHash: null as string | null,
        registrationEncryptionVersion: null as number | null,
        registrationEncryptionNonce: null as string | null,
        registrationAuthenticationTag: null as string | null,
        registrationEncryptedToken: null as string | null,
        registrationLinkExpiresAt: null as typeof requestTime | null,
        registrationLinkGeneration: sql`coalesce(${schema.invitation.registrationLinkGeneration}, 0) + 1`,
        registrationLinkRevokedAt: requestTime,
        registrationLinkRevokedBy: "SYSTEM",
      }

      // Soft-delete only pending invitations with the same pending email but a
      // different invitation_id so pending uniqueness is preserved without
      // mutating accepted or legacy-closed history. Only runs when this path will
      // actually upsert a pending invitation.
      yield* db
        .update(schema.invitation)
        .set({
          _deleted: true,
          invitationPendingEmail: null,
          ...clearRegistrationLinkOnHydrate,
          updatedAt: requestTime,
        })
        .where(
          and(
            eq(schema.invitation.invitationPendingEmail, normalizedEmail),
            ne(schema.invitation.invitationId, invitation.id),
            eq(schema.invitation.invitationStatus, "pending"),
            eq(schema.invitation._deleted, false),
          ),
        )

      // Only update still-pending rows on conflict so concurrent acceptance
      // cannot reopen accepted/legacy-closed history.
      yield* db
        .insert(schema.invitation)
        .values({
          invitationId: invitation.id,
          email: normalizedEmail,
          invitationStatus: "pending",
          invitationSource: "model",
          invitationPendingEmail: normalizedEmail,
          createdAt: requestTime,
          updatedAt: requestTime,
        })
        .onConflictDoUpdate({
          target: schema.invitation.invitationId,
          targetWhere: sql`_deleted = 0`,
          set: {
            email: normalizedEmail,
            invitationSource: "model",
            invitationPendingEmail: normalizedEmail,
            _deleted: false,
            updatedAt: requestTime,
          },
          // Qualify for dialect parity with Postgres ON CONFLICT DO UPDATE WHERE.
          setWhere: eq(schema.invitation.invitationStatus, "pending"),
        })

      // Re-read after upsert: non-pending rows are immutable history.
      const afterUpsert = yield* db
        .select({
          id: schema.invitation.id,
          email: schema.invitation.email,
          invitationStatus: schema.invitation.invitationStatus,
        })
        .from(schema.invitation)
        .where(
          and(
            eq(schema.invitation.invitationId, invitation.id),
            eq(schema.invitation._deleted, false),
          ),
        )
        .limit(1)
      const invitationRow = afterUpsert[0]
      assert(
        invitationRow,
        `Invitation upsert did not produce a row for ${invitation.id}`,
      )
      if (invitationRow.invitationStatus !== "pending") {
        return invitationRow.id
      }
      const invitationPk = invitationRow.id
      const emailChanged =
        existingInvitation !== undefined &&
        existingInvitation.email !== normalizedEmail

      // Claim the still-pending invitation for this hydrate transaction so
      // concurrent acceptance cannot rewrite roles mid-flight (UPDATE locks the
      // row until the outer hydrate transaction commits). If acceptance already
      // won, skip role mutation entirely.
      const claimedPending = yield* db
        .update(schema.invitation)
        .set({ updatedAt: requestTime })
        .where(
          and(
            eq(schema.invitation.id, invitationPk),
            eq(schema.invitation.invitationStatus, "pending"),
            eq(schema.invitation._deleted, false),
          ),
        )
        .returning({ id: schema.invitation.id })
      if (claimedPending.length === 0) {
        return invitationPk
      }

      // Get existing invitation roles
      const existingInvitationRoles = yield* db
        .select({
          id: schema.invitationRole.id,
          roleId: schema.invitationRole.roleId,
          deleted: schema.invitationRole._deleted,
        })
        .from(schema.invitationRole)
        .where(eq(schema.invitationRole.invitationId, invitationPk))

      const existingRoleIds = new Set(
        existingInvitationRoles.map((ir) => ir.roleId),
      )
      const existingActiveRoleIds = new Set(
        existingInvitationRoles
          .filter((ir) => !ir.deleted)
          .map((ir) => ir.roleId),
      )
      const desiredRoleIds = new Set(roleIds)

      // Determine what to add and remove (including soft-deleted rows to reactivate).
      const roleIdsToAdd = roleIds.filter((id) => !existingRoleIds.has(id))
      const invitationRoleIdsToRemove = existingInvitationRoles
        .filter((ir) => !ir.deleted && !desiredRoleIds.has(ir.roleId))
        .map((ir) => ir.id)
      const rolesChanged =
        roleIds.some((id) => !existingActiveRoleIds.has(id)) ||
        [...existingActiveRoleIds].some((id) => !desiredRoleIds.has(id))

      // Invalidate Registration Link when the grant's identity or roles change.
      // Only touch rows that still hold token material so never-generated
      // invitations are not mislabelled as revoked.
      if (emailChanged || rolesChanged) {
        yield* db
          .update(schema.invitation)
          .set({
            ...clearRegistrationLinkOnHydrate,
            updatedAt: requestTime,
          })
          .where(
            and(
              eq(schema.invitation.id, invitationPk),
              eq(schema.invitation.invitationStatus, "pending"),
              eq(schema.invitation._deleted, false),
              isNotNull(schema.invitation.registrationTokenHash),
            ),
          )
      }

      // Insert new invitation roles
      if (roleIdsToAdd.length > 0) {
        yield* db.insert(schema.invitationRole).values(
          roleIdsToAdd.map((roleId) => ({
            invitationId: invitationPk,
            roleId,
            createdAt: requestTime,
            updatedAt: requestTime,
          })),
        )
      }

      // Soft delete removed invitation roles
      if (invitationRoleIdsToRemove.length > 0) {
        yield* db
          .update(schema.invitationRole)
          .set({ _deleted: true, updatedAt: requestTime })
          .where(inArray(schema.invitationRole.id, invitationRoleIdsToRemove))
      }

      // Un-delete any previously soft-deleted invitation roles that should now be active
      const roleIdsToReactivate = roleIds.filter((id) =>
        existingRoleIds.has(id),
      )
      if (roleIdsToReactivate.length > 0) {
        const invitationRoleIdsToReactivate = existingInvitationRoles
          .filter((ir) => roleIdsToReactivate.includes(ir.roleId))
          .map((ir) => ir.id)
        if (invitationRoleIdsToReactivate.length > 0) {
          yield* db
            .update(schema.invitationRole)
            .set({ _deleted: false, updatedAt: requestTime })
            .where(
              inArray(schema.invitationRole.id, invitationRoleIdsToReactivate),
            )
        }
      }

      return invitationPk
    }),

  deleteOrphanedInvitations: (currentInvitationIds: string[]) =>
    Effect.gen(function* () {
      const db = yield* TypedSqliteDrizzle
      const requestTime = yield* getRequestTime()

      // Ownership is invitation_source, never guessed from invitation_id shape.
      // Only pending model-owned grants are revoked by model removal.
      const modelPendingOrphan =
        currentInvitationIds.length === 0
          ? and(
              eq(schema.invitation.invitationSource, "model"),
              eq(schema.invitation.invitationStatus, "pending"),
              eq(schema.invitation._deleted, false),
            )
          : and(
              eq(schema.invitation.invitationSource, "model"),
              eq(schema.invitation.invitationStatus, "pending"),
              eq(schema.invitation._deleted, false),
              notInArray(schema.invitation.invitationId, currentInvitationIds),
            )

      const orphaned = yield* db
        .update(schema.invitation)
        .set({
          _deleted: true,
          invitationPendingEmail: null,
          updatedAt: requestTime,
        })
        .where(modelPendingOrphan)
        .returning({ id: schema.invitation.id })

      if (orphaned.length > 0) {
        yield* db
          .update(schema.invitationRole)
          .set({ _deleted: true, updatedAt: requestTime })
          .where(
            and(
              inArray(
                schema.invitationRole.invitationId,
                orphaned.map((row) => row.id),
              ),
              eq(schema.invitationRole._deleted, false),
            ),
          )
      }
    }),

  upsertOAuthClient: (clientId: string, secretHash: string, audience: string) =>
    Effect.gen(function* () {
      const db = yield* TypedSqliteDrizzle
      const requestTime = yield* getRequestTime()

      yield* db
        .insert(schema.oauthClient)
        .values({
          clientId,
          clientSecretHash: secretHash,
          audience,
          createdAt: requestTime,
          updatedAt: requestTime,
        })
        .onConflictDoUpdate({
          target: schema.oauthClient.clientId,
          targetWhere: sql`_deleted = 0`,
          set: {
            clientSecretHash: secretHash,
            audience,
            _deleted: false,
            updatedAt: requestTime,
          },
        })
    }),

  deleteOrphanedOAuthClients: (currentClientIds: string[]) =>
    Effect.gen(function* () {
      const db = yield* TypedSqliteDrizzle
      const requestTime = yield* getRequestTime()

      if (currentClientIds.length === 0) {
        // Soft delete all OAuth clients
        yield* db
          .update(schema.oauthClient)
          .set({ _deleted: true, updatedAt: requestTime })
      } else {
        // Soft delete OAuth clients not in current list
        yield* db
          .update(schema.oauthClient)
          .set({ _deleted: true, updatedAt: requestTime })
          .where(notInArray(schema.oauthClient.clientId, currentClientIds))
      }
    }),

  upsertWeeklySchedule: (schedule, orgUnitId) =>
    Effect.gen(function* () {
      const db = yield* TypedSqliteDrizzle
      const requestTime = yield* getRequestTime()

      yield* db
        .insert(schema.weeklySchedule)
        .values({
          orgUnitId,
          dayOfWeek: schedule.dayOfWeek,
          timeRanges: schedule.timeRanges as unknown as Record<string, unknown>,
          createdAt: requestTime,
          updatedAt: requestTime,
        })
        .onConflictDoUpdate({
          target: [
            schema.weeklySchedule.orgUnitId,
            schema.weeklySchedule.dayOfWeek,
          ],
          targetWhere: sql`_deleted = 0`,
          set: {
            timeRanges: schedule.timeRanges as unknown as Record<
              string,
              unknown
            >,
            _deleted: false,
            updatedAt: requestTime,
          },
        })
    }),

  deleteOrphanedWeeklySchedules: (currentKeys) =>
    Effect.gen(function* () {
      const db = yield* TypedSqliteDrizzle
      const requestTime = yield* getRequestTime()

      if (currentKeys.length === 0) {
        // Soft delete all weekly schedules
        yield* db
          .update(schema.weeklySchedule)
          .set({ _deleted: true, updatedAt: requestTime })
        return
      }

      // Build map of org unit path to database ID (only active org units)
      const orgUnitPathToIdMap = new Map<string, string>()
      const orgUnits = yield* db
        .select({ id: schema.orgUnit.id, path: schema.orgUnit.path })
        .from(schema.orgUnit)
        .where(eq(schema.orgUnit._deleted, false))
      for (const ou of orgUnits) {
        orgUnitPathToIdMap.set(ou.path, ou.id)
      }

      // Convert pairs to (orgUnitId, dayOfWeek) tuples
      const currentPairIds = currentKeys
        .map(({ orgUnitPath, dayOfWeek }) => {
          const orgUnitId = orgUnitPathToIdMap.get(orgUnitPath)
          return orgUnitId ? { orgUnitId, dayOfWeek } : null
        })
        .filter(
          (pair): pair is { orgUnitId: string; dayOfWeek: number } =>
            pair !== null,
        )

      // Get all existing weekly schedules
      const existingSchedules = yield* db
        .select({
          id: schema.weeklySchedule.id,
          orgUnitId: schema.weeklySchedule.orgUnitId,
          dayOfWeek: schema.weeklySchedule.dayOfWeek,
        })
        .from(schema.weeklySchedule)

      // Find schedules to soft delete (those not in current list)
      const scheduleIdsToDelete = existingSchedules
        .filter(
          (sched) =>
            !currentPairIds.some(
              (pair) =>
                pair.orgUnitId === sched.orgUnitId &&
                pair.dayOfWeek === sched.dayOfWeek,
            ),
        )
        .map((sched) => sched.id)

      if (scheduleIdsToDelete.length > 0) {
        yield* db
          .update(schema.weeklySchedule)
          .set({ _deleted: true, updatedAt: requestTime })
          .where(inArray(schema.weeklySchedule.id, scheduleIdsToDelete))
      }
    }),

  upsertHolidayRule: (holiday, orgUnitId) =>
    Effect.gen(function* () {
      const db = yield* TypedSqliteDrizzle
      const requestTime = yield* getRequestTime()

      yield* db
        .insert(schema.holidayInstance)
        .values({
          orgUnitId,
          holidayTitle: holiday.name,
          holidayRule: holiday.rule as unknown as Record<string, unknown>,
          createdAt: requestTime,
          updatedAt: requestTime,
        })
        .onConflictDoUpdate({
          target: [
            schema.holidayInstance.orgUnitId,
            schema.holidayInstance.holidayTitle,
          ],
          targetWhere: sql`_deleted = 0`,
          set: {
            holidayRule: holiday.rule as unknown as Record<string, unknown>,
            _deleted: false,
            updatedAt: requestTime,
          },
        })
    }),

  deleteOrphanedHolidayRules: (currentKeys) =>
    Effect.gen(function* () {
      const db = yield* TypedSqliteDrizzle
      const requestTime = yield* getRequestTime()

      if (currentKeys.length === 0) {
        // Soft delete all holiday rules
        yield* db
          .update(schema.holidayInstance)
          .set({ _deleted: true, updatedAt: requestTime })
        return
      }

      // Build map of org unit path to database ID (only active org units)
      const orgUnitPathToIdMap = new Map<string, string>()
      const orgUnits = yield* db
        .select({ id: schema.orgUnit.id, path: schema.orgUnit.path })
        .from(schema.orgUnit)
        .where(eq(schema.orgUnit._deleted, false))
      for (const ou of orgUnits) {
        orgUnitPathToIdMap.set(ou.path, ou.id)
      }

      // Convert pairs to (orgUnitId, holidayTitle) tuples
      const currentPairIds = currentKeys
        .map(({ orgUnitPath, holidayTitle }) => {
          const orgUnitId = orgUnitPathToIdMap.get(orgUnitPath)
          return orgUnitId && holidayTitle ? { orgUnitId, holidayTitle } : null
        })
        .filter(
          (pair): pair is { orgUnitId: string; holidayTitle: string } =>
            pair !== null,
        )

      // Get all existing holiday rules
      const existingHolidays = yield* db
        .select({
          id: schema.holidayInstance.id,
          orgUnitId: schema.holidayInstance.orgUnitId,
          holidayTitle: schema.holidayInstance.holidayTitle,
        })
        .from(schema.holidayInstance)

      // Find holidays to soft delete (those not in current list)
      const holidayIdsToDelete = existingHolidays
        .filter(
          (hol) =>
            !currentPairIds.some(
              (pair) =>
                pair.orgUnitId === hol.orgUnitId &&
                pair.holidayTitle === hol.holidayTitle,
            ),
        )
        .map((hol) => hol.id)

      if (holidayIdsToDelete.length > 0) {
        yield* db
          .update(schema.holidayInstance)
          .set({ _deleted: true, updatedAt: requestTime })
          .where(inArray(schema.holidayInstance.id, holidayIdsToDelete))
      }
    }),

  upsertDocumentStore: (data, orgUnitId) =>
    Effect.gen(function* () {
      const db = yield* TypedSqliteDrizzle
      const requestTime = yield* getRequestTime()

      const result = yield* db
        .insert(schema.documentStore)
        .values({
          orgUnitId,
          name: data.name,
          path: data.path,
          acceptedTypes: data.acceptedTypes ?? null,
          sizeLimit: data.maxFileSize ?? null,
          createdAt: requestTime,
          updatedAt: requestTime,
        })
        .onConflictDoUpdate({
          target: schema.documentStore.path,
          targetWhere: sql`_deleted = 0`,
          set: {
            name: data.name,
            orgUnitId,
            acceptedTypes: data.acceptedTypes ?? null,
            sizeLimit: data.maxFileSize ?? null,
            updatedAt: requestTime,
          },
        })
        .returning({ id: schema.documentStore.id })

      return (yield* returnedRow(result)).id
    }),

  deleteOrphanedDocumentStores: (currentPaths: string[]) =>
    Effect.gen(function* () {
      const db = yield* TypedSqliteDrizzle
      const requestTime = yield* getRequestTime()

      if (currentPaths.length === 0) {
        yield* db
          .update(schema.documentStore)
          .set({ _deleted: true, updatedAt: requestTime })
      } else {
        yield* db
          .update(schema.documentStore)
          .set({ _deleted: true, updatedAt: requestTime })
          .where(notInArray(schema.documentStore.path, currentPaths))
      }
    }),

  upsertStepDocumentStore: (stepId, documentStoreId) =>
    Effect.gen(function* () {
      const db = yield* TypedSqliteDrizzle
      const requestTime = yield* getRequestTime()

      yield* db
        .insert(schema.stepDocumentStore)
        .values({
          stepId,
          documentStoreId,
          createdAt: requestTime,
          updatedAt: requestTime,
        })
        .onConflictDoUpdate({
          target: [
            schema.stepDocumentStore.stepId,
            schema.stepDocumentStore.documentStoreId,
          ],
          targetWhere: sql`_deleted = 0`,
          set: {
            _deleted: false,
            updatedAt: requestTime,
          },
        })
    }),

  deleteOrphanedStepDocumentStores: (currentKeys) =>
    Effect.gen(function* () {
      const db = yield* TypedSqliteDrizzle
      const requestTime = yield* getRequestTime()

      if (currentKeys.length === 0) {
        // Soft delete all step-document-store entries
        yield* db
          .update(schema.stepDocumentStore)
          .set({ _deleted: true, updatedAt: requestTime })
        return
      }

      // Build map of step path to database ID (only active steps)
      const stepPathToIdMap = new Map<string, string>()
      const steps = yield* db
        .select({ id: schema.step.id, path: schema.step.path })
        .from(schema.step)
        .where(eq(schema.step._deleted, false))
      for (const s of steps) {
        stepPathToIdMap.set(s.path, s.id)
      }

      // Build map of document store path to database ID (only active stores)
      const storePathToIdMap = new Map<string, string>()
      const stores = yield* db
        .select({
          id: schema.documentStore.id,
          path: schema.documentStore.path,
        })
        .from(schema.documentStore)
        .where(eq(schema.documentStore._deleted, false))
      for (const s of stores) {
        storePathToIdMap.set(s.path, s.id)
      }

      // Convert pairs to (stepId, documentStoreId) tuples
      const currentPairIds = currentKeys
        .map(({ stepPath, documentStorePath }) => {
          const stepId = stepPathToIdMap.get(stepPath)
          const documentStoreId = storePathToIdMap.get(documentStorePath)
          return stepId && documentStoreId ? { stepId, documentStoreId } : null
        })
        .filter(
          (pair): pair is { stepId: string; documentStoreId: string } =>
            pair !== null,
        )

      // Get all existing step-document-store entries
      const existingEntries = yield* db
        .select({
          id: schema.stepDocumentStore.id,
          stepId: schema.stepDocumentStore.stepId,
          documentStoreId: schema.stepDocumentStore.documentStoreId,
        })
        .from(schema.stepDocumentStore)

      // Find entries to soft delete (those not in current list)
      const entryIdsToDelete = existingEntries
        .filter(
          (entry) =>
            !currentPairIds.some(
              (pair) =>
                pair.stepId === entry.stepId &&
                pair.documentStoreId === entry.documentStoreId,
            ),
        )
        .map((entry) => entry.id)

      if (entryIdsToDelete.length > 0) {
        yield* db
          .update(schema.stepDocumentStore)
          .set({ _deleted: true, updatedAt: requestTime })
          .where(inArray(schema.stepDocumentStore.id, entryIdsToDelete))
      }
    }),
})
