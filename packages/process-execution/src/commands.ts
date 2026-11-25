import { createHash } from "node:crypto"
import { Effect, type Schema } from "effect"
import {
  ProcessQueries,
  type ProcessState,
  StepCompletionOperations,
  UserDetails,
} from "@pf/graphql-db-operations"
import { NotAuthorized } from "@pf/graphql-schema/errors"
import { OrganisationProvider, isForm, normalizePath } from "@pf/process"
import {
  checkScheduleModeAuthorization,
  checkStepAuthorization,
} from "./lib/authorization"
import type { ExecutionIdentity } from "./lib/identity"
import {
  hasDelegation,
  isProviderUserSession,
  processStartTriggerForSession,
} from "./lib/identity"
import {
  completeStep,
  startProcessExecution,
  startProcess as submitStartForm,
} from "./lib/process-operations"
import { type TodoActor, authorizeTodo } from "./lib/todo-admission"

export type { TodoActor } from "./lib/todo-admission"

export interface StartProcessCommand {
  readonly processPath: string
  /** Omit for a no-input start; supplying even {} submits a Form's callbacks.
   * Field-bearing Forms always validate. System starts retain initial state.
   */
  readonly input?: ProcessState
  readonly identity: ExecutionIdentity
  readonly executionId?: string
  readonly withoutWaiting?: boolean
}

const resolveStart = (processPath: string) =>
  Effect.gen(function* () {
    const { organisation } = yield* OrganisationProvider
    const queries = yield* ProcessQueries
    const path = normalizePath(processPath)
    const model = organisation
      .processes()
      .find((process) => normalizePath(process.node.path) === path)
    const starts = model?.startNodes() ?? []
    const step = starts[0]
    const rows = yield* queries.queryAllProcesses
    const process = rows.find((row) => row.path === path)
    if (!process || !step || starts.length !== 1)
      return yield* new NotAuthorized({
        action: "start",
        resource: path,
        message: "Process start is not available",
      })
    return {
      process,
      step,
      path,
      stepPath: normalizePath(step.node.path),
      cronStart: Boolean(model?.props.cron && step.isSystemStep),
    }
  })

export const startProcess = (command: StartProcessCommand) =>
  Effect.gen(function* () {
    const { process, step, path, stepPath, cronStart } = yield* resolveStart(
      command.processPath,
    )
    const rolePath = yield* checkStepAuthorization(
      command.identity,
      stepPath,
      "complete",
      cronStart ? { cronStart: true } : undefined,
    )
    yield* checkScheduleModeAuthorization(
      command.identity,
      path,
      command.withoutWaiting ?? false,
    )
    const options = {
      ...(command.executionId === undefined
        ? {}
        : { executionId: command.executionId }),
      withoutWaiting: command.withoutWaiting ?? false,
      ...(rolePath ? { completingRolePath: rolePath } : {}),
      trigger: processStartTriggerForSession(command.identity.session),
    }
    // GraphQL no-input starts omit input; the runner explicitly submits even {}.
    // Omitting input never bypasses validation of a field-bearing Form.
    return yield* isForm(step) &&
    (command.input !== undefined || Object.keys(step.output ?? {}).length > 0)
      ? submitStartForm(
          process.id,
          path,
          stepPath,
          command.input ?? {},
          step.submissionEffectSchema,
          step,
          command.identity,
          options,
        )
      : startProcessExecution(process.id, path, stepPath, command.input ?? {}, {
          ...options,
          enqueueStartSystemStep: step.isSystemStep,
          validateActivation: step.process.props.validateActivation,
        })
  })

export const completeTodo = (command: {
  readonly todoId: string
  readonly input: ProcessState
  readonly actor: TodoActor
  readonly expectedStepPath?: string
  readonly completionFingerprint?: string
}): Effect.Effect<
  Effect.Success<ReturnType<typeof completeStep>>,
  Effect.Error<ReturnType<typeof completeStep>> | NotAuthorized,
  Effect.Services<ReturnType<typeof completeStep>> | OrganisationProvider
> =>
  Effect.gen(function* () {
    yield* authorizeTodo(command.todoId, command.actor)
    const operations = yield* StepCompletionOperations
    const todo = yield* operations.queryTodoForCompletionById(command.todoId)
    const { organisation } = yield* OrganisationProvider
    const form = todo ? organisation.formByPath(todo.targetStepPath) : undefined
    if (
      !form ||
      (command.expectedStepPath !== undefined &&
        normalizePath(command.expectedStepPath) !==
          normalizePath(form.node.path))
    )
      return yield* new NotAuthorized({
        action: "complete",
        resource: command.todoId,
        message: "Not authorized to complete step",
      })
    return yield* completeStep(
      command.todoId,
      command.input,
      form,
      form.submissionEffectSchema,
      command.actor.identity,
      {
        actor: command.actor,
        ...(command.completionFingerprint === undefined
          ? {}
          : { completionFingerprint: command.completionFingerprint }),
        ...(command.actor.kind === "public-completion"
          ? {
              source: "public" as const,
              ...(command.actor.capability.externalParticipantEmail
                ? {
                    externalParticipantEmail:
                      command.actor.capability.externalParticipantEmail,
                  }
                : {}),
            }
          : {}),
      },
    )
  })

const isJsonArray = (
  value: Schema.JsonObject | Schema.JsonArray,
): value is Schema.JsonArray => Array.isArray(value)

const orderJson = (value: Schema.Json): Schema.Json => {
  if (value === null || typeof value !== "object") return value
  if (isJsonArray(value)) return value.map(orderJson)
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => [key, orderJson(item)]),
  )
}

export const completeTodoFromChat = (command: {
  readonly todoId: string
  readonly input: Schema.JsonObject
  readonly identity: ExecutionIdentity
}): ReturnType<typeof completeTodo> =>
  Effect.gen(function* () {
    const { todoId, input, identity } = command
    if (
      !identity.subject ||
      !isProviderUserSession(identity.session) ||
      hasDelegation(identity.session)
    )
      return yield* new NotAuthorized({
        action: "complete",
        resource: todoId,
        message: "A signed-in person is required to complete this To-Do.",
      })
    // The runtime records this alongside the winning transition, not in the
    // MCP connection. The user ID survives sign-in; the JWT subject does not.
    const completionFingerprint = createHash("sha256")
      .update(
        JSON.stringify([identity.session.userId, todoId, orderJson(input)]),
      )
      .digest("hex")
    return yield* completeTodo({
      todoId,
      input,
      actor: { kind: "authenticated", identity },
      completionFingerprint,
    })
  })

export const submitAnonymousPage = (command: {
  readonly address: string
  readonly input: ProcessState
}) =>
  Effect.gen(function* () {
    const { organisation } = yield* OrganisationProvider
    for (const model of organisation.processes()) {
      const starts = model.startNodes()
      const form = starts[0]
      if (
        starts.length !== 1 ||
        !form ||
        !isForm(form) ||
        form.anonymousPage?.address !== command.address
      )
        continue
      const { process, path, stepPath } = yield* resolveStart(model.node.path)
      return yield* submitStartForm(
        process.id,
        path,
        stepPath,
        command.input,
        form.submissionEffectSchema,
        form,
        { session: undefined, userId: undefined },
        { trigger: "human" },
      ).pipe(
        Effect.provideService(UserDetails, { by: "Anonymous Page", id: null }),
      )
    }
    return yield* new NotAuthorized({
      action: "anonymousPage",
      resource: "Anonymous Page",
      message: "This page is not available.",
    })
  })
