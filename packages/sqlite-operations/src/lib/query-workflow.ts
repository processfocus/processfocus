import { and, eq, inArray, isNull, or } from "drizzle-orm"
import { Effect, Layer } from "effect"
import * as schema from "@pf/drizzle-sqlite"
import {
  ProcessNotFoundError,
  type WorkflowData,
  WorkflowQueries,
  normalizeTaggedErrors,
} from "@pf/graphql-db-operations"
import { TypedSqliteDrizzle } from "@pf/service-drizzle-sqlite"

/**
 * Live implementation of WorkflowQueries service for SQLite.
 */
export const SqliteWorkflowQueriesLive = Layer.effect(
  WorkflowQueries,
  Effect.gen(function* () {
    const db = yield* TypedSqliteDrizzle

    return {
      queryWorkflowByProcessPath: (processPath: string) =>
        Effect.gen(function* () {
          // Query process by path
          const processes = yield* db
            .select({
              id: schema.process.id,
              name: schema.process.name,
              path: schema.process.path,
              purpose: schema.process.purpose,
            })
            .from(schema.process)
            .where(
              and(
                eq(schema.process.path, processPath),
                eq(schema.process._deleted, false),
              ),
            )
            .limit(1)

          const processData = processes[0]
          if (!processData) {
            return yield* new ProcessNotFoundError({
              path: processPath,
              message: `Process not found: ${processPath}`,
            })
          }

          // Query all steps for this process with role info, phase info, and start step status
          const steps = yield* db
            .select({
              id: schema.step.id,
              name: schema.step.name,
              path: schema.step.path,
              purpose: schema.step.purpose,
              processId: schema.step.processId,
              roleId: schema.step.roleId,
              roleName: schema.role.name,
              rolePath: schema.role.path,
              phaseId: schema.phase.id,
              phaseName: schema.phase.name,
              phasePath: schema.phase.path,
              phaseOrder: schema.phase.phaseOrder,
              isStartStep: schema.stepItsCanStartProcess.canStartProcess,
              isEmbedded: schema.step.embedded,
            })
            .from(schema.step)
            .leftJoin(schema.role, eq(schema.step.roleId, schema.role.id))
            .leftJoin(schema.phase, eq(schema.step.phaseId, schema.phase.id))
            .innerJoin(
              schema.stepItsCanStartProcess,
              eq(schema.step.id, schema.stepItsCanStartProcess.id),
            )
            .where(
              and(
                eq(schema.step.processId, processData.id),
                eq(schema.step._deleted, false),
                or(isNull(schema.step.roleId), eq(schema.role._deleted, false)),
              ),
            )

          // Get step IDs for flow query
          const stepIds = steps.map((s) => s.id)

          // Query flows connecting steps in this process
          const flows =
            stepIds.length > 0
              ? yield* db
                  .select({
                    id: schema.flow.id,
                    sourceStepId: schema.flow.sourceStepId,
                    targetStepId: schema.flow.targetStepId,
                    condition: schema.flow.condition,
                    fallbackBranch: schema.flow.fallbackBranch,
                    errorBranch: schema.flow.errorBranch,
                    errorTags: schema.flow.errorTags,
                    schedule: schema.flow.schedule,
                  })
                  .from(schema.flow)
                  .where(
                    and(
                      eq(schema.flow._deleted, false),
                      or(
                        inArray(schema.flow.sourceStepId, stepIds),
                        inArray(schema.flow.targetStepId, stepIds),
                      ),
                    ),
                  )
              : []

          // Query role responsibilities for this process
          const responsibilities = yield* db
            .select({
              roleId: schema.roleResponsibility.roleId,
              roleName: schema.role.name,
              rolePath: schema.role.path,
              responsibility: schema.roleResponsibility.responsibility,
              order: schema.roleResponsibility.responsibilityOrder,
            })
            .from(schema.roleResponsibility)
            .innerJoin(
              schema.role,
              eq(schema.roleResponsibility.roleId, schema.role.id),
            )
            .where(
              and(
                eq(schema.roleResponsibility.processId, processData.id),
                eq(schema.roleResponsibility._deleted, false),
                eq(schema.role._deleted, false),
              ),
            )

          const result: WorkflowData = {
            processId: processData.id,
            processName: processData.name,
            processPath: processData.path,
            processPurpose: processData.purpose,
            steps: steps.map((s) => ({
              id: s.id,
              name: s.name,
              path: s.path,
              purpose: s.purpose,
              processId: s.processId,
              roleId: s.roleId,
              roleName: s.roleName,
              rolePath: s.rolePath,
              phaseId: s.phaseId,
              phaseName: s.phaseName,
              phasePath: s.phasePath,
              phaseOrder: s.phaseOrder,
              isStartStep: s.isStartStep,
              isEmbedded: s.isEmbedded,
            })),
            flows: flows.map((f) => ({
              id: f.id,
              sourceStepId: f.sourceStepId,
              targetStepId: f.targetStepId,
              condition: f.condition,
              isElse: f.fallbackBranch,
              isOnError: f.errorBranch,
              taggedErrors: normalizeTaggedErrors(f.errorTags),
              schedule: f.schedule,
            })),
            responsibilities: responsibilities.map((r) => ({
              roleId: r.roleId,
              roleName: r.roleName,
              rolePath: r.rolePath,
              responsibility: r.responsibility,
              order: r.order,
            })),
          }

          return result
        }),
    }
  }),
)
