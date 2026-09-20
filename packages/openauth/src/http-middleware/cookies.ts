/**
 * Cookie middleware and service using Effect.
 *
 * Provides an Effect-based API for managing cookies in HTTP requests/responses.
 * Uses @effect/platform Cookies for parsing and serialization.
 *
 * @packageDocumentation
 */

import {
  Cookies,
  HttpMiddleware,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform"
import { Context, Duration, Effect, Ref } from "effect"

/**
 * Cookie options for setting cookies.
 */
export interface CookieOptions {
  maxAge?: number
  expires?: Date
  path?: string
  domain?: string
  secure?: boolean
  httpOnly?: boolean
  sameSite?: "lax" | "strict" | "none"
}

/**
 * Pending cookie operation.
 */
interface PendingCookie {
  name: string
  value: string
  options: CookieOptions
}

/**
 * Cookie service for managing request/response cookies.
 */
export interface CookieService {
  /**
   * Get a cookie value from the request.
   */
  readonly get: (name: string) => Effect.Effect<string | undefined>
  /**
   * Set a cookie to be added to the response.
   */
  readonly set: (
    name: string,
    value: string,
    options?: CookieOptions,
  ) => Effect.Effect<void>
  /**
   * Delete a cookie by setting it to expire immediately.
   */
  readonly delete: (
    name: string,
    options?: Pick<CookieOptions, "path" | "domain">,
  ) => Effect.Effect<void>
  /**
   * Get all pending cookies (for applying to response).
   */
  readonly getPending: () => Effect.Effect<readonly PendingCookie[]>
}

export const CookieService = Context.GenericTag<CookieService>(
  "@pf/openauth/CookieService",
)

/**
 * Create a CookieService layer from the current request.
 */
export const makeCookieService = () =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const cookieHeader = request.headers["cookie"] ?? ""
    const parsedCookies = Cookies.parseHeader(cookieHeader)
    const pendingCookies = yield* Ref.make<PendingCookie[]>([])

    const service: CookieService = {
      get: (name) =>
        Effect.succeed(parsedCookies[name]),

      set: (name, value, options = {}) =>
        Ref.update(pendingCookies, (cookies) => [
          ...cookies,
          { name, value, options },
        ]),

      delete: (name, options = {}) =>
        Ref.update(pendingCookies, (cookies) => [
          ...cookies,
          { name, value: "", options: { ...options, maxAge: 0, expires: new Date(0) } },
        ]),

      getPending: () => Ref.get(pendingCookies),
    }

    return service
  })

/**
 * Serialize a cookie with options into a Set-Cookie header value.
 */
export const serializeCookie = (
  name: string,
  value: string,
  options: CookieOptions = {},
): string => {
  const platformOptions: Parameters<typeof Cookies.unsafeMakeCookie>[2] = {
    maxAge:
      options.maxAge !== undefined
        ? Duration.seconds(options.maxAge)
        : undefined,
    expires: options.expires,
    path: options.path,
    domain: options.domain,
    secure: options.secure,
    httpOnly: options.httpOnly,
    sameSite: options.sameSite,
  }

  const cookie = Cookies.unsafeMakeCookie(name, value, platformOptions)
  return Cookies.serializeCookie(cookie)
}

/**
 * Cookie middleware that provides CookieService and applies pending cookies to responses.
 */
export const cookieMiddleware = HttpMiddleware.make((app) =>
  Effect.gen(function* () {
    const cookieService = yield* makeCookieService()
    const response = yield* app.pipe(
      Effect.provideService(CookieService, cookieService),
    )

    // Apply pending cookies to response
    const pending = yield* cookieService.getPending()
    if (pending.length === 0) {
      return response
    }

    // Build Set-Cookie headers
    const setCookieHeaders: string[] = pending.map(({ name, value, options }) =>
      serializeCookie(name, value, options),
    )

    // Append Set-Cookie headers to response
    return HttpServerResponse.setHeaders(response, {
      "Set-Cookie": setCookieHeaders.join(", "),
    })
  }),
)

/**
 * Apply pending cookies to a response.
 * Use this when not using the middleware but still need to apply cookies.
 */
export const applyCookiesToResponse = (
  pending: readonly PendingCookie[],
  response: HttpServerResponse.HttpServerResponse,
): HttpServerResponse.HttpServerResponse => {
  if (pending.length === 0) {
    return response
  }

  const setCookieHeaders = pending.map(({ name, value, options }) =>
    serializeCookie(name, value, options),
  )

  return HttpServerResponse.setHeaders(response, {
    "Set-Cookie": setCookieHeaders.join(", "),
  })
}

/**
 * Get a cookie value from the request (standalone function).
 */
export const getCookie = (name: string) =>
  Effect.gen(function* () {
    const cookieService = yield* CookieService
    return yield* cookieService.get(name)
  })

/**
 * Set a cookie (standalone function).
 */
export const setCookie = (
  name: string,
  value: string,
  options?: CookieOptions,
) =>
  Effect.gen(function* () {
    const cookieService = yield* CookieService
    return yield* cookieService.set(name, value, options)
  })

/**
 * Delete a cookie (standalone function).
 */
export const deleteCookie = (
  name: string,
  options?: Pick<CookieOptions, "path" | "domain">,
) =>
  Effect.gen(function* () {
    const cookieService = yield* CookieService
    return yield* cookieService.delete(name, options)
  })
