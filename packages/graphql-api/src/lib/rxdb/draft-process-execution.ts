import {
  Context,
  Data,
  DateTime,
  Effect,
  Equal,
  Layer,
  Result,
  Schema,
} from "effect"
import {
  AuthorizationService,
  type DelegationPrincipal,
  type ProviderUserPrincipal,
  type ServiceAccountPrincipal,
} from "@pf/auth-policy"
import { calculateFieldCompletion } from "@pf/form-schema"
import { submissionSchemaSync } from "@pf/form-submission-schema"
import {
  DraftProcessExecutionQueries,
  type DraftProcessExecutionRow,
  type StepRoleInfo,
} from "@pf/graphql-db-operations"
import type {
  DraftProcessExecution,
  DraftProcessExecutionInputPushRowT0NewDocumentStateT0,
} from "@pf/graphql-schema"
import { type Form, OrganisationProvider, isForm } from "@pf/process"
import { trySequentialStepAuthorization } from "../authorization"
import type { DraftProcessExecutionEventDocument } from "../draft-process-events"
import { getProcessPathFromStepPath } from "../resolver-utils"
import type { RxDbCollectionOps } from "./collection-ops"

const ProcessStateSchema = Schema.Record(Schema.String, Schema.Unknown)

export const canSaveStartForm = (
  principal:
    | ProviderUserPrincipal
    | DelegationPrincipal
    | ServiceAccountPrincipal,
  stepPath: string,
  step: StepRoleInfo | undefined,
) =>
  Effect.gen(function* () {
    if (!step?.startsProcess) return false
    const auth = yield* AuthorizationService
    return yield* trySequentialStepAuthorization(
      step,
      stepPath,
      getProcessPathFromStepPath(stepPath),
      (resource) => auth.canCompleteStep(principal, resource),
    )
  })

const decodeProcessState = (state: unknown) =>
  Schema.decodeUnknownEffect(ProcessStateSchema)(state ?? {}).pipe(
    Effect.mapError(
      (cause) => new Error("Invalid draft process execution state", { cause }),
    ),
  )

/**
 * Error when step cannot be found by path.
 */
class StepNotFoundByPathError extends Data.TaggedError(
  "StepNotFoundByPathError",
)<{
  readonly stepPath: string
  readonly processId: string
}> {
  override get message() {
    return `Step not found at path "${this.stepPath}" in process "${this.processId}"`
  }
}

/**
 * Finds a step by its path in the organisation.
 * The stepPath is a complete path like "hr/on-boarding/Send welcome pack"
 * that includes org unit, process, and step names.
 */
const findStepByPath = (
  stepPath: string,
  processId: string,
): Effect.Effect<Form, StepNotFoundByPathError, OrganisationProvider> =>
  Effect.gen(function* () {
    const { organisation: org } = yield* OrganisationProvider

    // Navigate from org root using the complete path
    const segments = stepPath.split("/").filter((segment) => segment.length > 0)

    let currentNode: typeof org = org

    for (const segment of segments) {
      const child = currentNode.node.tryFindChild(segment)
      if (!child) {
        return yield* new StepNotFoundByPathError({ stepPath, processId })
      }
      currentNode = child as typeof org
    }

    if (!isForm(currentNode)) {
      return yield* new StepNotFoundByPathError({ stepPath, processId })
    }

    return currentNode
  })

/**
 * Calculates fieldsCompleted and totalFields for a draft process execution.
 * Falls back to 0/0 if step or schema cannot be found.
 */
const calculateFieldCompletionForRow = (
  row: DraftProcessExecutionRow,
): Effect.Effect<
  { fieldsCompleted: number; totalFields: number },
  never,
  OrganisationProvider
> =>
  Effect.gen(function* () {
    // Try to find the step and its schema
    const stepResult = yield* Effect.result(
      findStepByPath(row.startStepPath, row.processId),
    )

    if (Result.isFailure(stepResult)) {
      yield* Effect.logWarning(
        `Cannot calculate field completion for draft ${row.id}: ${stepResult.failure.message}`,
      )
      return { fieldsCompleted: 0, totalFields: 0 }
    }

    const step = stepResult.success

    if (!step.output) {
      return { fieldsCompleted: 0, totalFields: 0 }
    }

    // Get the submission schema. Forms already validated flatten at construction;
    // rethrow the original tagged error if an invalid schema is encountered.
    const inputSchema = Schema.Struct(step.output)
    const subSchema = submissionSchemaSync(inputSchema)

    return calculateFieldCompletion(subSchema, row.state)
  })

/**
 * Map database row to GraphQL document type.
 * Computes fieldsCompleted and totalFields by validating against the step's schema.
 */
const mapRowToGraphqlWithValidation = (
  row: DraftProcessExecutionRow,
): Effect.Effect<
  DraftProcessExecutionEventDocument,
  never,
  OrganisationProvider
> =>
  Effect.gen(function* () {
    const { fieldsCompleted, totalFields } =
      yield* calculateFieldCompletionForRow(row)

    return {
      ...row,
      lastSaved: DateTime.toEpochMillis(row.lastSaved),
      fieldsCompleted,
      totalFields,
    }
  })

/**
 * RxDB collection operations for DraftProcessExecution.
 *
 * This service adapts the DraftProcessExecutionQueries to the generic
 * RxDbCollectionOps interface, enabling use with the generic resolvers.
 */
export class DraftProcessExecutionCollectionOps extends Context.Service<
  DraftProcessExecutionCollectionOps,
  RxDbCollectionOps<
    DraftProcessExecutionRow,
    DraftProcessExecution,
    DraftProcessExecutionInputPushRowT0NewDocumentStateT0,
    OrganisationProvider
  >
>()("@pf/graphql-api/DraftProcessExecutionCollectionOps") {}

/**
 * Live implementation that delegates to DraftProcessExecutionQueries.
 * Note: mapToGraphql is NOT used by the current implementation, as we compute
 * fieldsCompleted/totalFields in pull/getByIds operations that return Effects.
 */
export const DraftProcessExecutionCollectionOpsLive = Layer.effect(
  DraftProcessExecutionCollectionOps,
  Effect.gen(function* () {
    const queries = yield* DraftProcessExecutionQueries

    return {
      pull: queries.pullDraftProcessExecution,

      insert: (id, input) =>
        Effect.gen(function* () {
          const state = yield* decodeProcessState(input.state)
          return yield* queries.insertProcessState(
            id,
            input.processId,
            input.startStepPath,
            state,
          )
        }),

      update: (id, input, assumedMasterState) =>
        Effect.gen(function* () {
          const state = yield* decodeProcessState(input.state)
          const assumedState = yield* decodeProcessState(
            assumedMasterState.state,
          )
          return yield* queries.updateProcessState(id, state, {
            ...assumedMasterState,
            state: assumedState,
          })
        }),

      delete: (id, assumedMasterState) =>
        Effect.gen(function* () {
          const assumedState = yield* decodeProcessState(
            assumedMasterState.state,
          )
          return yield* queries.deleteProcessState(id, {
            ...assumedMasterState,
            state: assumedState,
          })
        }),

      getByIds: queries.getProcessStates,

      // The server stamps the saved revision. A later optimistic write may
      // already be queued against the browser's copy of the same values.
      matchesMaster: (current, assumed) =>
        current.id === assumed.id &&
        current.processId === assumed.processId &&
        current.startStepPath === assumed.startStepPath &&
        current.deleted === assumed.deleted &&
        Equal.equals(current.state, assumed.state),

      mapToGraphql: mapRowToGraphqlWithValidation,
    }
  }),
)
