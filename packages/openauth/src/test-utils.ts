/**
 * Test utilities for testing HttpApp-based servers.
 *
 * Provides a `.request()` method similar to the old Router interface
 * for easier testing.
 *
 * @packageDocumentation
 */

import { HttpApp } from "@effect/platform"
import { Runtime } from "effect"
import type { Issuer } from "./issuer.js"

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
 * Options for createTestApp.
 */
export interface CreateTestAppOptions {
  /**
   * Base URL for relative paths.
   * @default "http://localhost"
   */
  baseUrl?: string
  /**
   * Runtime to use for handling requests.
   * If not provided, uses Runtime.defaultRuntime.
   * When the app requires services at request time, provide a runtime that has those services.
   */
  runtime?: Runtime.Runtime<never>
}

/**
 * Create a TestApp from an HttpApp (Issuer).
 *
 * The TestApp tracks the last used base URL (origin) so relative URLs in redirects
 * are resolved correctly.
 *
 * @param app - The HttpApp to wrap
 * @param optionsOrBaseUrl - Options object or base URL string for backward compatibility
 * @returns TestApp with `.request()` method
 */
export const createTestApp = (
  app: Issuer,
  optionsOrBaseUrl?: CreateTestAppOptions | string,
): TestApp => {
  // Support both old (baseUrl string) and new (options object) signatures
  const options: CreateTestAppOptions =
    typeof optionsOrBaseUrl === "string"
      ? { baseUrl: optionsOrBaseUrl }
      : optionsOrBaseUrl ?? {}

  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL
  const runtime = options.runtime ?? Runtime.defaultRuntime
  const handler = HttpApp.toWebHandlerRuntime(runtime)(app)

  // Track the last used origin for resolving relative URLs
  let lastOrigin = baseUrl as string

  return {
    request: async (urlOrRequest, init) => {
      let absoluteUrl: string
      if (typeof urlOrRequest === "string") {
        // If URL is relative, resolve against the last used origin
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

      // Parse the URL and update lastOrigin for future relative URLs
      const url = new URL(absoluteUrl)
      lastOrigin = url.origin

      // Extract method, body, and initial headers based on input type
      let method: string = "GET"
      let body: BodyInit | null = null
      let inputHeaders: HeadersInit | undefined

      if (typeof urlOrRequest === "string" || urlOrRequest instanceof URL) {
        method = init?.method ?? "GET"
        body = init?.body ?? null
        inputHeaders = init?.headers
      } else {
        // Request object
        method = urlOrRequest.method
        body = urlOrRequest.body
        inputHeaders = urlOrRequest.headers
      }

      // Create initial headers from init
      const headers = new Headers(inputHeaders)

      // Merge in the host header if not already set
      // This ensures the issuer URL in tokens matches the request URL
      if (!headers.has("host")) {
        headers.set("host", url.host)
      }
      // Set x-forwarded-proto based on the URL protocol
      if (!headers.has("x-forwarded-proto")) {
        headers.set("x-forwarded-proto", url.protocol.replace(":", ""))
      }

      // Create the request with appropriate headers
      const initOptions = typeof urlOrRequest === "string" || urlOrRequest instanceof URL
        ? init
        : {}
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
