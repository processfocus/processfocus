import { SqlClient } from "@effect/sql"
import {
  QueueService,
  WebhookCallbackError,
  WebhookCallbackHost,
  type WebhookCallbackResult,
  dispatchServerPluginWebhook,
} from "@processfocus/runtime"
import { DateTime, Effect, FiberRef, Layer, Option } from "effect"
import {
  BusinessCalendarQueries,
  FlowExecutionOperations,
  ScheduledFlowOperations,
  StepCompletionOperations,
  UserDetails,
  decodeDelegationAudit,
} from "@pf/graphql-db-operations"
import { OrganisationProvider } from "@pf/process"
import { RequestTime } from "@pf/request-time"
import {
  completeAsyncSystemStep,
  failAsyncSystemStep,
} from "./complete-system-step"
import { applyPublicCompletionDeliveryCallback } from "./public-completion-delivery"

const applied = (): WebhookCallbackResult => ({ _tag: "Applied" })
const ignored = (): WebhookCallbackResult => ({ _tag: "Ignored" })

const mapCallbackError = <Result, Failure, Requirements>(
  message: string,
  effect: Effect.Effect<Result, Failure, Requirements>,
): Effect.Effect<Result, WebhookCallbackError, Requirements> =>
  effect.pipe(
    Effect.mapError((cause) => new WebhookCallbackError({ message, cause })),
  )

/** Shared local/AWS implementation of provider-neutral webhook callbacks. */
export const makeWebhookCallbackHost = Effect.gen(function* () {
  const stepCompletionOps = yield* StepCompletionOperations
  const scheduledFlowOps = yield* ScheduledFlowOperations
  const flowExecutionOps = yield* FlowExecutionOperations
  const calendarQueries = yield* BusinessCalendarQueries
  const queueService = yield* QueueService
  const sqlClient = yield* SqlClient.SqlClient
  const requestTimeRef = yield* RequestTime
  const userDetailsRef = yield* UserDetails

  const setSystemRequestContext = Effect.gen(function* () {
    const now = yield* DateTime.now
    yield* FiberRef.set(requestTimeRef, now)
    yield* FiberRef.set(userDetailsRef, { by: "SYSTEM", id: null })
  })

  return {
    lookupDeferredTodo: (todoId: string) =>
      mapCallbackError(
        `Failed to look up deferred Todo ${todoId}`,
        Effect.gen(function* () {
          const todo = yield* stepCompletionOps.queryTodoById(todoId)
          if (!todo) return null
          const processState =
            yield* stepCompletionOps.getProcessStateByTodoId(todoId)
          return processState ? { state: processState.state } : null
        }),
      ),

    completeDeferredTodo: (
      input: Parameters<WebhookCallbackHost["Type"]["completeDeferredTodo"]>[0],
    ) =>
      mapCallbackError(
        `Failed to complete deferred Todo ${input.todoId}`,
        Effect.gen(function* () {
          yield* setSystemRequestContext
          const todo = yield* stepCompletionOps.queryTodoById(input.todoId)
          if (!todo) return ignored()
          if (
            todo.createdBy &&
            Option.isSome(decodeDelegationAudit(todo.createdBy))
          ) {
            yield* FiberRef.set(userDetailsRef, {
              by: todo.createdBy,
              id: null,
            })
          }

          const didComplete = yield* completeAsyncSystemStep({
            todoId: todo.id,
            stepPath: todo.targetStepPath,
            output: input.output,
            todoInfo: {
              createdAtMs: todo.createdAtMs,
              orgUnitId: todo.orgUnitId,
              processExecutionId: todo.processExecutionId,
              processStateId: todo.processStateId,
              barrierScheduledFlowId: todo.barrierScheduledFlowId,
              targetStepId: todo.targetStepId,
            },
            isForEach: todo.hasForEach,
            queueService,
            stepCompletionOps,
            scheduledFlowOps,
            flowExecutionOps,
            calendarQueries,
            sqlClient,
          })

          yield* Effect.log(
            didComplete
              ? "Webhook callback completed deferred Todo"
              : "Webhook callback ignored already-resolved deferred Todo",
            {
              todoId: todo.id,
              processExecutionId: todo.processExecutionId,
              stepPath: todo.targetStepPath,
              callbackId: input.callbackId,
            },
          )
          return didComplete ? applied() : ignored()
        }).pipe(
          Effect.provideService(RequestTime, requestTimeRef),
          Effect.provideService(UserDetails, userDetailsRef),
        ),
      ),

    failDeferredTodo: (
      input: Parameters<WebhookCallbackHost["Type"]["failDeferredTodo"]>[0],
    ) =>
      mapCallbackError(
        `Failed to fail deferred Todo ${input.todoId}`,
        Effect.gen(function* () {
          yield* setSystemRequestContext
          const todo = yield* stepCompletionOps.queryTodoById(input.todoId)
          if (!todo) return ignored()
          if (
            todo.createdBy &&
            Option.isSome(decodeDelegationAudit(todo.createdBy))
          ) {
            yield* FiberRef.set(userDetailsRef, {
              by: todo.createdBy,
              id: null,
            })
          }

          const result = yield* failAsyncSystemStep({
            todoId: todo.id,
            processExecutionId: todo.processExecutionId,
            failureReason: input.failureReason,
            ...(input.errorTag !== undefined && {
              errorTag: input.errorTag,
            }),
            queueService,
            stepCompletionOps,
            scheduledFlowOps,
            flowExecutionOps,
            sqlClient,
          })

          yield* Effect.log(
            result.didFail
              ? "Webhook callback failed deferred Todo"
              : "Webhook callback ignored already-resolved deferred Todo",
            {
              todoId: todo.id,
              processExecutionId: todo.processExecutionId,
              stepPath: todo.targetStepPath,
              callbackId: input.callbackId,
            },
          )
          return result.didFail ? applied() : ignored()
        }).pipe(
          Effect.provideService(RequestTime, requestTimeRef),
          Effect.provideService(UserDetails, userDetailsRef),
        ),
      ),

    applyPublicCompletionCallback: (
      callback: Parameters<
        WebhookCallbackHost["Type"]["applyPublicCompletionCallback"]
      >[0],
    ) =>
      mapCallbackError(
        `Failed to apply public-completion callback ${callback.deliveryId}`,
        Effect.gen(function* () {
          yield* setSystemRequestContext
          const result = yield* applyPublicCompletionDeliveryCallback(callback)
          return result._tag === "Ignored" ? ignored() : applied()
        }).pipe(
          Effect.provideService(StepCompletionOperations, stepCompletionOps),
          Effect.provideService(FlowExecutionOperations, flowExecutionOps),
          Effect.provideService(QueueService, queueService),
          Effect.provideService(SqlClient.SqlClient, sqlClient),
          Effect.provideService(RequestTime, requestTimeRef),
          Effect.provideService(UserDetails, userDetailsRef),
        ),
      ),
  }
})

/** Shared HTTP webhook router used by both local and AWS runtime hosts. */
export const makeServerPluginWebhookRouter = Effect.gen(function* () {
  const organisationProvider = yield* OrganisationProvider
  const callbackHost = yield* makeWebhookCallbackHost

  return (request: Request): Effect.Effect<Response> | undefined => {
    if (!new URL(request.url).pathname.startsWith("/webhooks/")) {
      return undefined
    }

    return dispatchServerPluginWebhook({
      request,
      registrations: organisationProvider.serverPlugins ?? [],
      callbackHost,
    })
  }
})

export const WebhookCallbackHostLive = Layer.effect(
  WebhookCallbackHost,
  makeWebhookCallbackHost,
)
