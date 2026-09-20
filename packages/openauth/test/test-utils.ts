/**
 * Test utilities - re-export from src for convenience.
 * Also provides createTestAppFromIssuer helper for tests.
 */

import {
  HttpApp,
  type HttpServerRequest,
  type HttpServerResponse,
} from "@effect/platform"
import { Effect, Layer, ManagedRuntime, type Runtime } from "effect"
import type {
  AllowCallbackInput,
  OnRefreshScopeInput,
  OnRefreshScopeResult,
  OnSuccessResponder,
  TokenTtl,
} from "../src/endpoints/types.js"
import {
  type Issuer,
  type IssuerClient,
  issuer,
  resolveIssuerClients,
} from "../src/issuer.js"
import type { Provider } from "../src/provider/provider.js"
import type {
  OnRefreshScopeError,
  SuccessCallbackError,
} from "../src/services/callbacks.js"
import {
  CookieAuthServiceLive,
  EncryptionServiceLive,
  KeyManagementServiceLive,
  defaultResolveSubject,
  defaultTokenTtl,
  makeClientRegistryService,
  makeIssuerCallbacks,
  makeProviderRegistryService,
  makeSubjectsConfig,
  makeTokenTtlConfig,
} from "../src/services/index.js"
import type { KeyManagementService } from "../src/services/key-management.js"
import { MemoryStorageServiceLive } from "../src/storage/memory.js"
import type { StorageService } from "../src/storage/storage.js"
import type { SubjectSchema } from "../src/subject.js"

/** Default base URL for test requests */
const DEFAULT_BASE_URL = "http://localhost"

/**
 * Wrapper around an HttpApp that provides a convenient `.request()` method for testing.
 */
export interface TestApp {
  /**
   * Make a request to the app and get a Response.
   *
   * @param urlOrRequest - URL string (absolute or relative), URL object, or Request object
   * @param init - Optional request init (headers, method, body, etc.)
   * @returns Promise<Response>
   */
  request: (
    urlOrRequest: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>
}

/**
 * Old-style issuer input config format (for test compatibility).
 */
export interface IssuerInput<
  Providers extends Record<string, Provider<unknown>>,
  Subjects extends SubjectSchema,
  Success = unknown,
> {
  subjects: Subjects
  clients?: IssuerClient[]
  providers: Providers
  listProviders?: () => Effect.Effect<readonly string[]>
  resolveProvider?: (
    name: string,
  ) => Effect.Effect<Provider<unknown> | undefined>
  ttl?: Partial<TokenTtl>
  success: (
    responder: OnSuccessResponder,
    value: Success,
    req: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    SuccessCallbackError,
    StorageService | HttpServerRequest.HttpServerRequest | KeyManagementService
  >
  allow?: (
    input: AllowCallbackInput,
    req: HttpServerRequest.HttpServerRequest,
  ) => Effect.Effect<boolean>
  start?: (req: HttpServerRequest.HttpServerRequest) => Effect.Effect<void>
  onRefreshScope?: (
    input: OnRefreshScopeInput,
  ) => Effect.Effect<OnRefreshScopeResult, OnRefreshScopeError>
}

// Define the services union type
type AllServices =
  | import("../src/services/index.js").ClientRegistryService
  | import("../src/services/index.js").CookieAuthService
  | import("../src/services/index.js").ProviderRegistryService
  | import("../src/services/index.js").TokenTtlConfig
  | import("../src/services/index.js").SubjectsConfig
  | import("../src/services/index.js").IssuerCallbacks
  | import("../src/services/index.js").KeyManagementService
  | import("../src/services/index.js").EncryptionService
  | StorageService

/**
 * Build all service layers from old-style issuer config.
 * Returns a Layer with all services for running the app.
 */
const buildAllLayersFromConfig = <
  Providers extends Record<string, Provider<unknown>>,
  Subjects extends SubjectSchema,
  Success,
>(
  config: IssuerInput<Providers, Subjects, Success>,
  resolvedClients: IssuerClient[],
): Layer.Layer<AllServices, never, never> => {
  // Build TTL config
  const ttl: TokenTtl = {
    access: config.ttl?.access ?? defaultTokenTtl.access,
    refresh: config.ttl?.refresh ?? defaultTokenTtl.refresh,
    refreshReuse: config.ttl?.refreshReuse ?? defaultTokenTtl.refreshReuse,
    refreshRetention: config.ttl?.refreshRetention ?? defaultTokenTtl.refreshRetention,
  }

  // Build layers for all services
  // For tests, we crash on invalid config (programming error)
  const clientRegistryLayer = makeClientRegistryService(resolvedClients).pipe(
    Layer.catchAll((error) => Layer.die(error)),
  )
  const providerRegistryLayer = makeProviderRegistryService(
    config.providers as Record<string, Provider<unknown>>,
    config.listProviders,
    config.resolveProvider,
  )
  const tokenTtlLayer = makeTokenTtlConfig(ttl)
  const subjectsLayer = makeSubjectsConfig(config.subjects)
  const callbacksLayer = makeIssuerCallbacks({
    success: config.success as (
      responder: OnSuccessResponder,
      value: unknown,
      req: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<
      HttpServerResponse.HttpServerResponse,
      SuccessCallbackError,
      StorageService | HttpServerRequest.HttpServerRequest | KeyManagementService
    >,
    allow: config.allow ?? ((_input, _req) => Effect.succeed(true)),
    start: config.start,
    onRefreshScope: config.onRefreshScope,
    resolveSubject: defaultResolveSubject,
  })

  // Layers that depend on StorageService
  const keyManagementLayer = KeyManagementServiceLive
  const encryptionLayer = EncryptionServiceLive
  const cookieAuthLayer = CookieAuthServiceLive

  // Compose all layers with MemoryStorageServiceLive for tests
  return Layer.mergeAll(
    clientRegistryLayer,
    providerRegistryLayer,
    tokenTtlLayer,
    subjectsLayer,
    callbacksLayer,
  ).pipe(
    Layer.provideMerge(cookieAuthLayer),
    Layer.provideMerge(encryptionLayer),
    Layer.provideMerge(keyManagementLayer),
    Layer.provideMerge(MemoryStorageServiceLive),
  )
}

/**
 * Create a TestApp with services wrapped into each request handler.
 */
const createTestAppWithLayers = (
  runtime: Runtime.Runtime<AllServices>,
  app: Issuer,
  baseUrl = DEFAULT_BASE_URL,
): TestApp => {
  // Create the handler once using the provided runtime
  const handler = HttpApp.toWebHandlerRuntime(runtime)(app)

  // Track the last used origin for resolving relative URLs
  let lastOrigin = baseUrl

  return {
    request: async (urlOrRequest, init) => {
      let absoluteUrl: string
      if (typeof urlOrRequest === "string") {
        if (urlOrRequest.startsWith("/")) {
          absoluteUrl = `${lastOrigin}${urlOrRequest}`
        } else {
          absoluteUrl = urlOrRequest
        }
      } else if (urlOrRequest instanceof URL) {
        absoluteUrl = urlOrRequest.toString()
      } else {
        absoluteUrl = urlOrRequest.url
      }

      const url = new URL(absoluteUrl)
      lastOrigin = url.origin

      let method: string = "GET"
      let body: RequestInit["body"] = null
      let inputHeaders: RequestInit["headers"]

      if (typeof urlOrRequest === "string" || urlOrRequest instanceof URL) {
        method = init?.method ?? "GET"
        body = init?.body ?? null
        inputHeaders = init?.headers
      } else {
        method = urlOrRequest.method
        body = urlOrRequest.body
        inputHeaders = urlOrRequest.headers
      }

      const headers = new Headers(inputHeaders)

      if (!headers.has("host")) {
        headers.set("host", url.host)
      }
      if (!headers.has("x-forwarded-proto")) {
        headers.set("x-forwarded-proto", url.protocol.replace(":", ""))
      }

      const initOptions =
        typeof urlOrRequest === "string" || urlOrRequest instanceof URL ? init : {}
      const request = new Request(absoluteUrl, {
        ...initOptions,
        method,
        headers,
        body,
      })

      return handler(request)
    },
  }
}

/**
 * Create an issuer (TestApp) from old-style config.
 * This is the main test helper that bridges old test code to new service-based issuer.
 *
 * The returned Effect requires StorageService, which createTestAppFromIssuer provides.
 *
 * @param config - Old-style issuer configuration
 * @returns Effect that creates a TestApp (requires StorageService)
 */
export const createIssuer = <
  Providers extends Record<string, Provider<unknown>>,
  Subjects extends SubjectSchema,
  Success = unknown,
>(
  config: IssuerInput<Providers, Subjects, Success>,
): Effect.Effect<TestApp, never, StorageService> =>
  Effect.gen(function* () {
    // Resolve clients from config + environment
    const resolvedClients = yield* resolveIssuerClients(config.clients).pipe(Effect.orDie)

    // Build all layers (includes MemoryStorageServiceLive for independent storage per issuer)
    const allLayers = buildAllLayersFromConfig(config, resolvedClients)

    // Create a ManagedRuntime FIRST - this will be the single source of truth for service instances
    const managedRuntime = ManagedRuntime.make(allLayers)

    // Get the actual runtime from the managed runtime
    const runtime = yield* Effect.promise(() => managedRuntime.runtime())

    // Build the issuer app using the SAME runtime (not the layers again)
    // This ensures the same encryption keys are used
    const app = yield* Effect.promise(() => managedRuntime.runPromise(issuer))

    // Create a TestApp with the runtime for request handling
    return createTestAppWithLayers(runtime, app)
  })

/**
 * Run the issuer Effect and create a TestApp.
 * Automatically provides MemoryStorageServiceLive for tests.
 * Configuration errors are converted to defects (tests should fail loudly).
 *
 * @param issuerEffect - Effect that creates a TestApp (requires StorageService)
 * @returns Promise<TestApp>
 */
export const createTestAppFromIssuer = async (
  issuerEffect: Effect.Effect<TestApp, never, StorageService>,
): Promise<TestApp> => {
  return await Effect.runPromise(
    issuerEffect.pipe(
      Effect.orDie,
      Effect.provide(MemoryStorageServiceLive),
    ),
  )
}
