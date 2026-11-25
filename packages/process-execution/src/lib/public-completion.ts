import { QueueService } from "@processfocus/runtime"
import { DateTime, Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { publicCompletionCorrectionForm } from "@pf/form-schema"
import {
  EXECUTION_EVENT_QUEUE,
  FlowExecutionOperations,
  NOTIFICATION_DELIVERY_QUEUE,
  PROCESS_EVENT_QUEUE,
  type PublicTodoInfo,
  StepCompletionOperations,
  TODO_EVENT_QUEUE,
  deepMerge,
  normalizeExternalParticipantEmail,
} from "@pf/graphql-db-operations"
import {
  InputValidationError,
  NotAuthorized,
  ProcessStateNotFound,
} from "@pf/graphql-schema/errors"
import {
  type FlowContext,
  type Form,
  OrganisationProvider,
  type StepMeta,
  buildFlowContext,
} from "@pf/process"
import {
  PUBLIC_TODO_TOKEN_AUDIENCE,
  type PublicTodoTokenPayload,
  buildPublicTodoUrl,
  encryptPublicTodoToken,
} from "@pf/public-completion/credentials"
import { getRequestTime } from "@pf/request-time"
import { completeTodo } from "../commands"
import {
  checkPublicCompletionCorrectionAuthorization,
  checkPublicTodoAuthorization,
} from "./authorization"
import type { ExecutionIdentity } from "./identity"
import { recoverExternalCompletionEnqueue } from "./process-operations"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
type PublicCompletionStatus = "ACTIVE" | "COMPLETED" | "EXPIRED" | "UNAVAILABLE"

type PublicTodoResult = {
  readonly todoId: string
  readonly status: PublicCompletionStatus
  readonly organisationName?: string | null
  readonly completionMessage?: string | null
}

const isTokenExpired = (exp: number, now: DateTime.DateTime) =>
  // Match capability-token UX: a link expires at the start of its expiry second.
  exp <= Math.floor(DateTime.toEpochMillis(now) / 1000)

type PublicTodoCapabilityResult =
  | {
      readonly type: "done"
      readonly result: PublicTodoResult
    }
  | {
      readonly type: "continue"
      readonly payload: PublicTodoTokenPayload
      readonly todo: PublicTodoInfo
      readonly stepPath: string
      readonly form: Form
    }

type PublicTodoCapability = Extract<
  PublicTodoCapabilityResult,
  { readonly type: "continue" }
>

const resolveMaybeEffect = <T>(
  value: T | Effect.Effect<T, unknown, unknown>,
) => (Effect.isEffect(value) ? value : Effect.succeed(value))

const normalizePublicRecipient = (
  recipient: string | { readonly email: string; readonly displayName?: string },
) =>
  typeof recipient === "string"
    ? { email: recipient }
    : {
        email: recipient.email,
        ...(recipient.displayName
          ? { displayName: recipient.displayName }
          : {}),
      }

const normalizePublicRecipientEmail = (email: string) =>
  email.trim().toLowerCase()

const resolveRegistrationLinkFrontendOrigin = (): string | null => {
  const configured =
    process.env["FRONTEND_BASE_URL"] ??
    process.env["BASE_URL"] ??
    process.env["NEXT_PUBLIC_FRONTEND_URL"]
  if (configured) {
    return configured.replace(/\/$/, "")
  }
  const nodeEnv = process.env["NODE_ENV"]
  if (nodeEnv === "development" || nodeEnv === "test") {
    return "http://localhost:3000"
  }
  return null
}

export const inspectPublicCompletion = (options: {
  readonly capability: PublicTodoTokenPayload
  readonly allowExpired?: boolean
}) =>
  Effect.gen(function* () {
    const payload = options.capability
    const requestTime = yield* getRequestTime()
    const stepCompletionOps = yield* StepCompletionOperations
    const todo = yield* stepCompletionOps.queryPublicTodoInfo(payload.tid)

    if (todo.status === "unavailable" || !todo.stepPath) {
      return {
        type: "done",
        result: {
          todoId: payload.tid,
          status: "UNAVAILABLE",
        } satisfies PublicTodoResult,
      } satisfies PublicTodoCapabilityResult
    }

    if (
      todo.latestPublicCompletionInvitationRecipientEmail !== null &&
      (!payload.externalParticipantEmail ||
        normalizePublicRecipientEmail(payload.externalParticipantEmail) !==
          normalizePublicRecipientEmail(
            todo.latestPublicCompletionInvitationRecipientEmail,
          ))
    ) {
      return {
        type: "done",
        result: {
          todoId: payload.tid,
          status: "UNAVAILABLE",
        } satisfies PublicTodoResult,
      } satisfies PublicTodoCapabilityResult
    }

    // Completion is terminal for the UX, even after the capability expires,
    // but only the latest invitation recipient retains the capability.
    if (todo.status === "completed") {
      return {
        type: "done",
        result: {
          todoId: payload.tid,
          status: "COMPLETED",
        } satisfies PublicTodoResult,
      } satisfies PublicTodoCapabilityResult
    }

    if (!options.allowExpired && isTokenExpired(payload.exp, requestTime)) {
      return {
        type: "done",
        result: {
          todoId: payload.tid,
          status: "EXPIRED",
        } satisfies PublicTodoResult,
      } satisfies PublicTodoCapabilityResult
    }

    yield* checkPublicTodoAuthorization(payload.tid, todo.todoId)

    const { organisation: org } = yield* OrganisationProvider
    const form = org.formByPath(todo.stepPath)
    if (!form) {
      yield* Effect.logError("Public todo form not found", {
        todoId: payload.tid,
        stepPath: todo.stepPath,
      })
      return {
        type: "done",
        result: {
          todoId: payload.tid,
          status: "UNAVAILABLE",
        } satisfies PublicTodoResult,
      } satisfies PublicTodoCapabilityResult
    }

    return {
      type: "continue",
      payload,
      todo,
      stepPath: todo.stepPath,
      form,
    } satisfies PublicTodoCapabilityResult
  })

const loadPublicCompletionRuntimeContext = (capability: PublicTodoCapability) =>
  Effect.gen(function* () {
    const { payload, form } = capability
    const typedForm = form as unknown as Form<
      Record<string, unknown>,
      Record<string, StepMeta>,
      Schema.Struct.Fields,
      string,
      unknown
    >
    const publicCompletion = typedForm.publicCompletion
    if (!publicCompletion) return null

    const stepCompletionOps = yield* StepCompletionOperations
    const processStateData = yield* stepCompletionOps.getProcessStateByTodoId(
      payload.tid,
    )
    if (!processStateData) return null

    const completedSteps =
      yield* stepCompletionOps.getCompletedStepsForExecution(
        processStateData.processExecutionId,
      )
    const ctx = buildFlowContext(
      processStateData.processExecutionId,
      processStateData.processStartedAt,
      completedSteps,
    ) as FlowContext<Record<string, StepMeta>>
    const item = capability.todo.itemData ?? undefined

    return { publicCompletion, processStateData, ctx, item }
  })

/** Public submission and duplicate dispatch recovery share live admission. */
export const submitPublicCompletion = (command: {
  readonly capability: PublicTodoTokenPayload
  readonly input: Record<string, unknown>
  readonly identity: ExecutionIdentity
}) =>
  Effect.gen(function* () {
    const capability = yield* inspectPublicCompletion(command)
    if (capability.type === "done") {
      if (capability.result.status === "COMPLETED") {
        yield* checkPublicTodoAuthorization(
          command.capability.tid,
          capability.result.todoId,
        )
        yield* recoverExternalCompletionEnqueue(capability.result.todoId)
      }
      return capability.result
    }
    let completionMessage = "Successfully submitted."
    const thankYou = capability.form.publicCompletion?.thankYou
    if (typeof thankYou === "string") completionMessage = thankYou
    else if (typeof thankYou === "function") {
      const runtime = yield* loadPublicCompletionRuntimeContext(capability)
      if (!runtime)
        return yield* new ProcessStateNotFound({
          todoId: capability.payload.tid,
          stepPath: capability.stepPath,
          message: `Process state not found for todo "${capability.payload.tid}"`,
        })
      const message = runtime.publicCompletion.thankYou
      if (typeof message === "function")
        completionMessage = yield* resolveMaybeEffect(
          message(runtime.processStateData.state, runtime.ctx, runtime.item),
        )
    }
    yield* completeTodo({
      todoId: capability.payload.tid,
      input: command.input,
      actor: {
        kind: "public-completion",
        capability: capability.payload,
        identity: command.identity,
      },
    })
    return {
      todoId: capability.payload.tid,
      status: "COMPLETED",
      completionMessage,
    } satisfies PublicTodoResult
  })

const enqueueFreshPublicCompletionInvitation = (
  capability: PublicTodoCapability,
  _identity: ExecutionIdentity,
  state: Record<string, unknown>,
  ctx: FlowContext<Record<string, StepMeta>>,
  item: unknown,
) =>
  Effect.gen(function* () {
    const { payload, form, stepPath } = capability
    const typedForm = form as unknown as Form<
      Record<string, unknown>,
      Record<string, StepMeta>,
      Schema.Struct.Fields,
      string,
      unknown
    >
    const publicCompletion = typedForm.publicCompletion
    if (!publicCompletion) return null

    const recipient = normalizePublicRecipient(
      yield* resolveMaybeEffect(publicCompletion.recipient(state, ctx, item)),
    )
    const expiresAt = yield* resolveMaybeEffect(
      publicCompletion.expiresAt(state, ctx, item),
    )
    const expiresAtIso = DateTime.formatIso(expiresAt)
    const stepName = form.props.name ?? stepPath.split("/").at(-1) ?? stepPath
    const frontendOrigin = resolveRegistrationLinkFrontendOrigin()
    if (!frontendOrigin) {
      return yield* new InputValidationError({
        errors: [
          {
            field: "",
            message: "FRONTEND_BASE_URL is not configured",
          },
        ],
      })
    }
    const stepCompletionOps = yield* StepCompletionOperations
    const publicCompletionInvitationAttemptId =
      yield* stepCompletionOps.createPublicCompletionInvitationAttempt({
        todoId: payload.tid,
        recipientEmail: recipient.email,
      })
    const freshToken = yield* encryptPublicTodoToken({
      v: 1,
      tid: payload.tid,
      externalParticipantEmail: recipient.email,
      publicCompletionInvitationAttemptId,
      iat: Math.floor(DateTime.toEpochMillis(yield* getRequestTime()) / 1000),
      exp: Math.floor(DateTime.toEpochMillis(expiresAt) / 1000),
      aud: payload.aud,
    })
    const publicUrl = buildPublicTodoUrl(frontendOrigin, freshToken)
    const subject = publicCompletion.subject
      ? yield* resolveMaybeEffect(
          publicCompletion.subject(state, ctx, item, publicUrl, expiresAt),
        )
      : undefined
    const body = publicCompletion.body
      ? yield* resolveMaybeEffect(
          publicCompletion.body(state, ctx, item, publicUrl, expiresAt),
        )
      : undefined
    const template = publicCompletion.template
      ? yield* resolveMaybeEffect(
          publicCompletion.template(state, ctx, item, publicUrl, expiresAt),
        )
      : undefined
    const attachments = publicCompletion.attachments
      ? yield* resolveMaybeEffect(
          publicCompletion.attachments(state, ctx, item),
        )
      : undefined

    const queueService = yield* QueueService
    const freshLinkPayload = {
      channel: "email" as const,
      recipient,
      publicTodo: {
        todoId: payload.tid,
        processName: form.process.props.name,
        stepName,
        token: freshToken,
        expiresAt: expiresAtIso,
        publicCompletionInvitationAttemptId,
        ...(subject !== undefined && { subject }),
        ...(body !== undefined && { body }),
        ...(template !== undefined && { template }),
        ...(attachments !== undefined && { attachments }),
      },
    }

    yield* queueService
      .enqueue(NOTIFICATION_DELIVERY_QUEUE, freshLinkPayload)
      .pipe(
        Effect.tapError((error) =>
          Effect.logWarning(
            "Failed to enqueue public completion invitation after recording invitation attempt",
            {
              todoId: payload.tid,
              publicCompletionInvitationAttemptId,
              error: String(error),
            },
          ),
        ),
      )

    return { recipient, publicCompletionInvitationAttemptId }
  })

export const correctPublicCompletion = ({
  todoId,
  correctedEmail,
  identity: context,
}: {
  readonly todoId: string
  readonly correctedEmail: string
  readonly identity: ExecutionIdentity
}) =>
  Effect.gen(function* () {
    yield* Schema.decodeUnknownEffect(publicCompletionCorrectionForm)({
      correctedEmail,
    }).pipe(
      Effect.mapError(
        () =>
          new InputValidationError({
            errors: [
              {
                field: "correctedEmail",
                message: "Enter a valid email address.",
              },
            ],
          }),
      ),
    )
    const normalizedCorrectedEmail =
      normalizeExternalParticipantEmail(correctedEmail)
    if (!normalizedCorrectedEmail) {
      return yield* new InputValidationError({
        errors: [
          {
            field: "correctedEmail",
            message: "Enter a valid email address.",
          },
        ],
      })
    }

    const stepCompletionOps = yield* StepCompletionOperations
    const todo = yield* stepCompletionOps.queryTodoById(todoId)
    if (!todo?.correctionRequiredAt) {
      return yield* new NotAuthorized({
        action: "publicCompletionCorrection",
        resource: todoId,
        message: `Public completion todo ${todoId} is not available for correction`,
      })
    }

    yield* checkPublicCompletionCorrectionAuthorization(context, {
      id: todo.id,
      stepPath: todo.targetStepPath,
      processPath: todo.processPath,
      processOrgUnitPath: todo.orgUnitPath,
      assignedToProviderUserEmail: todo.assignedToProviderUserEmail,
    })

    const { organisation: org } = yield* OrganisationProvider
    const form = org.formByPath(todo.targetStepPath)
    const typedForm = form as unknown as
      | Form<
          Record<string, unknown>,
          Record<string, StepMeta>,
          Schema.Struct.Fields,
          string,
          unknown
        >
      | undefined
    const publicCompletion = typedForm?.publicCompletion
    const correction = publicCompletion?.correction
    if (!form || !typedForm || !publicCompletion || !correction) {
      return yield* new NotAuthorized({
        action: "publicCompletionCorrection",
        resource: todoId,
        message: `Public completion todo ${todoId} is not configured for correction`,
      })
    }

    const processStateData =
      yield* stepCompletionOps.getProcessStateByTodoId(todoId)
    if (!processStateData) {
      return yield* new ProcessStateNotFound({
        todoId,
        stepPath: todo.targetStepPath,
        message: `Process state not found for todo "${todoId}"`,
      })
    }

    const completedSteps =
      yield* stepCompletionOps.getCompletedStepsForExecution(
        processStateData.processExecutionId,
      )
    const ctx = buildFlowContext(
      processStateData.processExecutionId,
      processStateData.processStartedAt,
      completedSteps,
    ) as FlowContext<Record<string, StepMeta>>
    const item = todo.itemData ?? undefined
    const patch = yield* resolveMaybeEffect(
      correction.applyEmail(
        processStateData.state,
        normalizedCorrectedEmail,
        ctx,
        item,
      ),
    )
    if (!isRecord(patch)) {
      return yield* new InputValidationError({
        errors: [
          {
            field: "correctedEmail",
            message: "Correction did not produce a process-state patch.",
          },
        ],
      })
    }

    const nextState = deepMerge(processStateData.state, patch)
    const resolvedRecipient = normalizePublicRecipient(
      yield* resolveMaybeEffect(
        publicCompletion.recipient(nextState, ctx, item),
      ),
    )
    const normalizedResolvedEmail = normalizeExternalParticipantEmail(
      resolvedRecipient.email,
    )
    if (normalizedResolvedEmail !== normalizedCorrectedEmail) {
      return yield* new InputValidationError({
        errors: [
          {
            field: "correctedEmail",
            message:
              "The corrected process state does not resolve to this email address.",
          },
        ],
      })
    }

    const capability: PublicTodoCapability = {
      type: "continue",
      // Only tid and aud are read when issuing the replacement token; iat/exp
      // are recomputed from the current request time and public-completion TTL.
      payload: {
        v: 1,
        tid: todoId,
        iat: 0,
        exp: 0,
        aud: PUBLIC_TODO_TOKEN_AUDIENCE,
      },
      todo: {
        todoId,
        status: "active",
        stepPath: todo.targetStepPath,
        // Correction submissions already resolved the recipient from the
        // provider-supplied correction, so stale public invitation checks do
        // not apply when issuing the replacement token.
        latestPublicCompletionInvitationRecipientEmail: null,
        itemData: todo.itemData,
      },
      stepPath: todo.targetStepPath,
      form,
    }

    const queueService = yield* QueueService
    const enqueueTodoProcessExecutionEvents = Effect.gen(function* () {
      yield* queueService.enqueue(TODO_EVENT_QUEUE, { todoIds: [todoId] })

      const flowExecutionOps = yield* FlowExecutionOperations
      const processId = yield* flowExecutionOps.getProcessIdForExecution(
        processStateData.processExecutionId,
      )
      if (processId) {
        yield* queueService.enqueue(PROCESS_EVENT_QUEUE, { processId })
      } else {
        yield* Effect.logWarning(
          "Unable to enqueue process event after public completion correction",
          {
            executionId: processStateData.processExecutionId,
            todoId,
          },
        )
      }

      yield* queueService.enqueue(EXECUTION_EVENT_QUEUE, {
        executionId: processStateData.processExecutionId,
      })
    })
    const clearCorrectionRequired = Effect.gen(function* () {
      const cleared =
        yield* stepCompletionOps.clearPublicCompletionCorrectionRequired(todoId)
      if (!cleared) {
        return yield* new NotAuthorized({
          action: "publicCompletionCorrection",
          resource: todoId,
          message: `Public completion todo ${todoId} is no longer available for correction`,
        })
      }
    })
    const reissueInvitation = enqueueFreshPublicCompletionInvitation(
      capability,
      context,
      nextState,
      ctx,
      item,
    )

    const transactionalApplyAndReissue = Effect.gen(function* () {
      yield* stepCompletionOps.updateProcessState(
        processStateData.processStateId,
        patch,
      )
      yield* clearCorrectionRequired
      yield* reissueInvitation
      yield* enqueueTodoProcessExecutionEvents
    })

    if (queueService.queueInTransaction) {
      const sql = yield* SqlClient.SqlClient
      yield* sql.withTransaction(transactionalApplyAndReissue)
    } else {
      yield* stepCompletionOps.updateProcessState(
        processStateData.processStateId,
        patch,
      )
      // Without transactional queueing, enqueue before clearing the correction
      // so a failed enqueue leaves the provider-facing correction flow intact.
      // If clearing fails after enqueue, a retry can send another invitation.
      yield* reissueInvitation
      yield* clearCorrectionRequired
      yield* enqueueTodoProcessExecutionEvents
    }

    return {
      todoId,
      processName: typedForm.process.props.name,
      stepName:
        typedForm.props.name ??
        todo.targetStepPath.split("/").at(-1) ??
        todo.targetStepPath,
      correctedEmail: normalizedCorrectedEmail,
      failureReason: null,
    }
  })

export const renewPublicCompletionInvitation = ({
  capability: payload,
}: {
  readonly capability: PublicTodoTokenPayload
}) =>
  Effect.gen(function* () {
    const context: ExecutionIdentity = { session: undefined, userId: undefined }
    const capability = yield* inspectPublicCompletion({
      capability: payload,
      allowExpired: true,
    })
    if (capability.type === "done") {
      return capability.result
    }

    const runtimeContext = yield* loadPublicCompletionRuntimeContext(capability)
    if (!runtimeContext) {
      return {
        todoId: capability.payload.tid,
        status: "UNAVAILABLE",
      } satisfies PublicTodoResult
    }

    const queueService = yield* QueueService
    if (queueService.queueInTransaction) {
      const sql = yield* SqlClient.SqlClient
      yield* sql.withTransaction(
        enqueueFreshPublicCompletionInvitation(
          capability,
          context,
          runtimeContext.processStateData.state,
          runtimeContext.ctx,
          runtimeContext.item,
        ),
      )
    } else {
      // External queues cannot share this DB transaction; an orphaned attempt
      // is acceptable if enqueue fails because no provider send happened.
      yield* enqueueFreshPublicCompletionInvitation(
        capability,
        context,
        runtimeContext.processStateData.state,
        runtimeContext.ctx,
        runtimeContext.item,
      )
    }

    return {
      todoId: capability.payload.tid,
      status: "ACTIVE",
    } satisfies PublicTodoResult
  })
