import {
  WebhookCallbackError,
  WebhookCallbackHost,
  type WebhookCallbackResult,
  dispatchServerPluginWebhook,
} from "@processfocus/runtime"
import { DateTime, Effect, Layer } from "effect"
import {
  StepCompletionOperations,
  UserDetails,
} from "@pf/graphql-db-operations"
import { OrganisationProvider } from "@pf/process"
import {
  applyPublicCompletionDeliveryCallback,
  completeAsyncSystemStep,
  failAsyncSystemStep,
} from "@pf/process-execution/worker"
import { RequestTime } from "@pf/request-time"

type ExecutionRequirements = Effect.Services<
  | ReturnType<typeof completeAsyncSystemStep>
  | ReturnType<typeof failAsyncSystemStep>
  | ReturnType<typeof applyPublicCompletionDeliveryCallback>
>

/** Runtime composition closes execution requirements and translates callback results. */
export const makeWebhookCallbackHost = Effect.gen(function* () {
  const services = yield* Effect.context<ExecutionRequirements>()
  const stepCompletionOps = yield* StepCompletionOperations
  const run = <A, E>(
    message: string,
    effect: Effect.Effect<A, E, ExecutionRequirements>,
  ) =>
    Effect.flatMap(DateTime.now, (now) =>
      effect.pipe(
        Effect.provideService(RequestTime, now),
        Effect.provideService(UserDetails, { by: "SYSTEM", id: null }),
        Effect.provide(services),
        Effect.mapError(
          (cause) => new WebhookCallbackError({ message, cause }),
        ),
      ),
    )
  const outcome = (applied: boolean): WebhookCallbackResult =>
    applied ? { _tag: "Applied" } : { _tag: "Ignored" }
  return {
    lookupDeferredTodo: (todoId: string) =>
      run(
        `Failed to look up deferred Todo ${todoId}`,
        Effect.gen(function* () {
          const todo = yield* stepCompletionOps.queryTodoById(todoId)
          if (!todo) return null
          const state = yield* stepCompletionOps.getProcessStateByTodoId(todoId)
          return state ? { state: state.state } : null
        }),
      ),
    completeDeferredTodo: (
      input: Parameters<
        WebhookCallbackHost["Service"]["completeDeferredTodo"]
      >[0],
    ) =>
      run(
        `Failed to complete deferred Todo ${input.todoId}`,
        completeAsyncSystemStep(input).pipe(Effect.map(outcome)),
      ),
    failDeferredTodo: (
      input: Parameters<WebhookCallbackHost["Service"]["failDeferredTodo"]>[0],
    ) =>
      run(
        `Failed to fail deferred Todo ${input.todoId}`,
        failAsyncSystemStep(input).pipe(
          Effect.map((result) => outcome(result.didFail)),
        ),
      ),
    applyPublicCompletionCallback: (
      callback: Parameters<
        WebhookCallbackHost["Service"]["applyPublicCompletionCallback"]
      >[0],
    ) =>
      run(
        `Failed to apply public-completion callback ${callback.deliveryId}`,
        applyPublicCompletionDeliveryCallback(callback).pipe(
          Effect.map((result) => outcome(result._tag !== "Ignored")),
        ),
      ),
  }
})

/** Shared HTTP webhook router used by both local and AWS runtime hosts. */
export const makeServerPluginWebhookRouter = Effect.gen(function* () {
  const organisationProvider = yield* OrganisationProvider
  const callbackHost = yield* makeWebhookCallbackHost
  return (request: Request): Effect.Effect<Response> | undefined => {
    if (!new URL(request.url).pathname.startsWith("/webhooks/"))
      return undefined
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
