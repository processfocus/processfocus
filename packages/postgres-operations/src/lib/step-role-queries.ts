import { and, asc, eq, inArray, isNull, or } from "drizzle-orm"
import { Effect, Layer } from "effect"
import * as schema from "@pf/drizzle-postgres"
import { type StepRoleInfo, StepRoleQueries } from "@pf/graphql-db-operations"
import { TypedPostgresDrizzle } from "@pf/service-drizzle-postgres"

/**
 * Live implementation of StepRoleQueries service for PostgreSQL.
 * Now queries the step's role directly from the step table (no junction table).
 */
export const PostgresStepRoleQueriesLive = Layer.effect(
  StepRoleQueries,
  Effect.gen(function* () {
    const db = yield* TypedPostgresDrizzle

    // Note: querySupportingRolePaths is intentionally duplicated with
    // sqlite-operations/src/lib/step-role-queries.ts. Keep both in sync.
    const querySupportingRolePaths = (stepPath: string) =>
      Effect.gen(function* () {
        const results = yield* db
          .select({ path: schema.role.path })
          .from(schema.stepSupportingRole)
          .innerJoin(
            schema.role,
            eq(schema.stepSupportingRole.roleId, schema.role.id),
          )
          .innerJoin(
            schema.step,
            eq(schema.stepSupportingRole.stepId, schema.step.id),
          )
          .where(
            and(
              eq(schema.step.path, stepPath),
              eq(schema.stepSupportingRole._deleted, false),
              eq(schema.role._deleted, false),
            ),
          )
          .orderBy(asc(schema.stepSupportingRole.createdAt))

        return results.map((r) => r.path)
      })

    const emptyResult = {
      rolePath: null,
      supportingRolePaths: [],
      startsProcess: false,
      embedded: false,
    } as const

    return {
      queryRolePathsByStepPath: (stepPath: string) =>
        Effect.gen(function* () {
          // Query step with its role and startsProcess info
          const stepInfo = yield* db
            .select({
              rolePath: schema.role.path,
              canStartProcess: schema.stepItsCanStartProcess.canStartProcess,
              embedded: schema.step.embedded,
            })
            .from(schema.step)
            .leftJoin(schema.role, eq(schema.step.roleId, schema.role.id))
            .innerJoin(
              schema.stepItsCanStartProcess,
              eq(schema.step.id, schema.stepItsCanStartProcess.id),
            )
            .where(
              and(
                eq(schema.step.path, stepPath),
                eq(schema.step._deleted, false),
                or(isNull(schema.role.id), eq(schema.role._deleted, false)),
              ),
            )
            .limit(1)

          const firstStep = stepInfo[0]
          if (!firstStep) {
            return { ...emptyResult }
          }

          const supportingRolePaths = yield* querySupportingRolePaths(stepPath)

          return {
            rolePath: firstStep.rolePath,
            supportingRolePaths,
            startsProcess: firstStep.canStartProcess,
            embedded: firstStep.embedded,
          }
        }),

      queryRolePathsByStepPaths: (stepPaths: string[]) =>
        Effect.gen(function* () {
          if (stepPaths.length === 0) {
            return new Map<string, StepRoleInfo>()
          }

          // Query all steps with their roles and startsProcess info
          const stepInfoResults = yield* db
            .select({
              stepId: schema.step.id,
              stepPath: schema.step.path,
              rolePath: schema.role.path,
              canStartProcess: schema.stepItsCanStartProcess.canStartProcess,
              embedded: schema.step.embedded,
            })
            .from(schema.step)
            .leftJoin(schema.role, eq(schema.step.roleId, schema.role.id))
            .innerJoin(
              schema.stepItsCanStartProcess,
              eq(schema.step.id, schema.stepItsCanStartProcess.id),
            )
            .where(
              and(
                inArray(schema.step.path, stepPaths),
                eq(schema.step._deleted, false),
                or(isNull(schema.role.id), eq(schema.role._deleted, false)),
              ),
            )

          // Single batch query for all supporting roles
          const stepIds = stepInfoResults.map((s) => s.stepId)
          const allSupporting =
            stepIds.length > 0
              ? yield* db
                  .select({
                    stepPath: schema.step.path,
                    rolePath: schema.role.path,
                  })
                  .from(schema.stepSupportingRole)
                  .innerJoin(
                    schema.role,
                    eq(schema.stepSupportingRole.roleId, schema.role.id),
                  )
                  .innerJoin(
                    schema.step,
                    eq(schema.stepSupportingRole.stepId, schema.step.id),
                  )
                  .where(
                    and(
                      inArray(schema.step.id, stepIds),
                      eq(schema.stepSupportingRole._deleted, false),
                      eq(schema.role._deleted, false),
                    ),
                  )
                  .orderBy(asc(schema.stepSupportingRole.createdAt))
              : []

          // Group supporting roles by step path
          const supportingByPath = new Map<string, string[]>()
          for (const r of allSupporting) {
            const paths = supportingByPath.get(r.stepPath)
            if (paths) {
              paths.push(r.rolePath)
            } else {
              supportingByPath.set(r.stepPath, [r.rolePath])
            }
          }

          // Build result map
          const map = new Map<string, StepRoleInfo>()

          // Initialize all requested steps with empty result
          for (const p of stepPaths) {
            map.set(p, { ...emptyResult })
          }

          // Update with actual step info + batched supporting roles
          for (const s of stepInfoResults) {
            map.set(s.stepPath, {
              rolePath: s.rolePath,
              supportingRolePaths: supportingByPath.get(s.stepPath) ?? [],
              startsProcess: s.canStartProcess,
              embedded: s.embedded,
            })
          }

          return map
        }),

      queryRoleIdByPath: (rolePath: string) =>
        Effect.gen(function* () {
          const results = yield* db
            .select({ id: schema.role.id })
            .from(schema.role)
            .where(
              and(
                eq(schema.role.path, rolePath),
                eq(schema.role._deleted, false),
              ),
            )
            .limit(1)
          return results[0]?.id
        }),
    }
  }),
)
