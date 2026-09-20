import "server-only"
import { Tracer as OtelTracer, Resource } from "@effect/opentelemetry"
import { Next } from "@mcrovero/effect-nextjs"
import { Effect, FiberRef, Layer } from "effect"
import { connection } from "next/server"
import { LoggerLive } from "./run-effect"
import { AccessToken, AccessTokenLive } from "./services/access-token"
import { CedarAuthorizationLayer } from "./services/authorization"
import { FormValidationServiceLive } from "./services/form-validation"
import { GraphQLServiceLive } from "./services/graphql"
import { getSessionWithToken } from "@/lib/auth/session"
import { SERVICE_NAME } from "@/lib/telemetry/constants"
/**
 * OpenNext bypasses NextServer.prepare(), so the instrumentation.ts register()
 * hook never runs in Lambda. We call registerOtel() here at module load time
 * as a workaround. This module is imported by every server page, so it runs
 * once on cold start before any requests are handled.
 *
 * In development, Next.js calls instrumentation.ts normally. registerOtel()
 * uses a globalThis sentinel to skip duplicate calls.
 */
import { registerOtel } from "@/lib/telemetry/register-otel"

export { runEffect, withLogger } from "./run-effect"

const otelRegistration = process.env["AWS_LAMBDA_FUNCTION_NAME"]
  ? registerOtel().catch((error: unknown) => {
      console.error("Failed to initialize OpenTelemetry in Lambda:", error)
    })
  : Promise.resolve()

/**
 * Effect tracer layer bridging Effect.withSpan to the global OTEL TracerProvider.
 *
 * OtelTracer.layerGlobal picks up the global TracerProvider and configures the
 * Effect fiber tracer so that Effect.withSpan creates real OTEL spans.
 *
 * Pattern from: https://github.com/mcrovero/effect-nextjs#opentelemetry
 */
const layerTracer = OtelTracer.layerGlobal.pipe(
  Layer.provide(Resource.layer({ serviceName: SERVICE_NAME })),
)

/**
 * Application-wide Effect runtime layer.
 * This combines all service layers needed by the application.
 *
 * Note: All layers must be stateless as per @mcrovero/effect-nextjs requirements.
 * For stateful layers, use globalValue with ManagedRuntime.
 */
export const AppLive = Layer.mergeAll(
  AccessTokenLive, // Provides FiberRef for access token
  GraphQLServiceLive, // Depends on AccessToken at runtime
  FormValidationServiceLive,
  LoggerLive,
)

/**
 * Extended runtime layer that includes Cedar authorization.
 * Use this for pages that need to check feature permissions server-side.
 *
 * Note: This layer can fail during construction if Cedar policies cannot be fetched.
 * Pages using this layer should handle errors gracefully.
 */
export const AppWithAuthorizationLive: Layer.Layer<
  | Layer.Layer.Success<typeof AppLive>
  | Layer.Layer.Success<typeof CedarAuthorizationLayer>,
  Layer.Layer.Error<typeof CedarAuthorizationLayer>
> = Layer.mergeAll(AppLive, CedarAuthorizationLayer)

/**
 * Application layers with OTEL tracer bridging.
 * Layer.provideMerge ensures the tracer layer is constructed and its output
 * is merged, so Effect.withSpan creates real OTEL spans.
 */
const AppLiveWithTracer = AppLive.pipe(Layer.provideMerge(layerTracer))
const AppWithAuthorizationLiveWithTracer = AppWithAuthorizationLive.pipe(
  Layer.provideMerge(layerTracer),
)

/**
 * Wrapper that retrieves the access token from session cookies and sets it
 * in the AccessToken FiberRef before running the page effect.
 *
 * This follows the same pattern as RequestTime/UserDetails in the backend GraphQL API.
 *
 * @param pageEffect - The page effect to run with access token set
 */
const withAccessToken = <A, E, R>(
  pageEffect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R | AccessToken> =>
  Effect.gen(function* () {
    const session = yield* getSessionWithToken.pipe(
      Effect.tapError((error) =>
        Effect.logError("Failed to get session with token", error),
      ),
      Effect.catchAll(() => Effect.succeed(null)),
    )
    const accessTokenRef = yield* AccessToken

    yield* FiberRef.set(accessTokenRef, { token: session?.accessToken ?? null })

    return yield* pageEffect
  })

const nextBasePage = Next.make("BasePage", AppLiveWithTracer)

/**
 * Base page runtime for server-side pages with automatic authentication.
 * The access token is retrieved from session cookies and made available to all
 * GraphQL operations within the page.
 */
export const BasePage = {
  build: <Args extends unknown[], A>(
    pageEffect: (
      ...args: Args
    ) => Effect.Effect<A, never, Layer.Layer.Success<typeof AppLive>>,
  ) => {
    const wrappedEffect = (...args: Args) =>
      withAccessToken(pageEffect(...args))
    const Component = nextBasePage.build(wrappedEffect)
    const BasePage = async (...args: Parameters<typeof Component>) => {
      await connection()
      await otelRegistration
      return Component(...args)
    }
    return BasePage
  },
}

const nextBasePageWithAuth = Next.make(
  "BasePageWithAuth",
  AppWithAuthorizationLiveWithTracer,
)

/**
 * Base page runtime with Cedar authorization support.
 * Use this for pages that need to check feature permissions server-side.
 *
 * If Cedar layer construction fails, the page will show an error.
 */
export const BasePageWithAuthorization = {
  build: <Args extends unknown[], A>(
    pageEffect: (
      ...args: Args
    ) => Effect.Effect<
      A,
      never,
      Layer.Layer.Success<typeof AppWithAuthorizationLive>
    >,
  ) => {
    const wrappedEffect = (...args: Args) =>
      withAccessToken(pageEffect(...args))
    const Component = nextBasePageWithAuth.build(wrappedEffect)
    const BasePageWithAuth = async (...args: Parameters<typeof Component>) => {
      await connection()
      await otelRegistration
      return Component(...args)
    }
    return BasePageWithAuth
  },
}

/**
 * Base layout runtime for layouts.
 * Layouts can use the same runtime infrastructure as pages.
 */
export const BaseLayout = Next.make("BaseLayout", AppLiveWithTracer)
