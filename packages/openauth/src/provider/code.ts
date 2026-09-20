/**
 * Configures a provider that supports pin code authentication. This is usually paired with the
 * `CodeUI`.
 *
 * ```ts
 * import { CodeUI } from "@openauthjs/openauth/ui/code"
 * import { CodeProvider } from "@openauthjs/openauth/provider/code"
 *
 * export default issuer({
 *   providers: {
 *     code: CodeProvider(
 *       CodeUI({
 *         copy: {
 *           code_info: "We'll send a pin code to your email"
 *         },
 *         sendCode: (claims, code) => console.log(claims.email, code)
 *       })
 *     )
 *   },
 *   // ...
 * })
 * ```
 *
 * You can customize the provider using.
 *
 * ```ts {7-9}
 * const ui = CodeUI({
 *   // ...
 * })
 *
 * export default issuer({
 *   providers: {
 *     code: CodeProvider(
 *       { ...ui, length: 4 }
 *     )
 *   },
 *   // ...
 * })
 * ```
 *
 * Behind the scenes, the `CodeProvider` expects callbacks that implements request handlers
 * that generate the UI for the following.
 *
 * ```ts
 * CodeProvider({
 *   // ...
 *   request: (req, state, form, error) => Promise<Response>
 * })
 * ```
 *
 * This allows you to create your own UI.
 *
 * @packageDocumentation
 */

import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform"
import { Effect } from "effect"
import { generateUnbiasedDigits, timingSafeCompare } from "../random.js"
import {
  type Provider,
  type ProviderOptions,
  tryProviderCallback,
} from "./provider.js"

export interface CodeProviderConfig<
  Claims extends Record<string, string> = Record<string, string>,
> {
  /**
   * The length of the pin code.
   *
   * @default 6
   */
  length?: number
  /**
   * The request handler to generate the UI for the code flow.
   *
   * Takes the standard [`Request`](https://developer.mozilla.org/en-US/docs/Web/API/Request)
   * and optionally form data as a Map<string, string>
   * ojects.
   *
   * Also passes in the current `state` of the flow and any `error` that occurred.
   *
   * Expects the [`Response`](https://developer.mozilla.org/en-US/docs/Web/API/Response) object
   * in return.
   */
  request: (
    req: HttpServerRequest.HttpServerRequest,
    state: CodeProviderState,
    form?: Map<string, string>,
    error?: CodeProviderError,
  ) => Promise<Response>
  /**
   * Callback to send the pin code to the user.
   *
   * @example
   * ```ts
   * {
   *   sendCode: async (claims, code) => {
   *     // Send the code through the email or phone number based on the claims
   *   }
   * }
   * ```
   */
  sendCode: (claims: Claims, code: string) => Promise<undefined | CodeProviderError>
}

/**
 * The state of the code flow.
 *
 * | State | Description |
 * | ----- | ----------- |
 * | `start` | The user is asked to enter their email address or phone number to start the flow. |
 * | `code` | The user needs to enter the pin code to verify their _claim_. |
 */
export type CodeProviderState =
  | {
      type: "start"
    }
  | {
      type: "code"
      resend?: boolean
      code: string
      claims: Record<string, string>
    }

/**
 * The errors that can happen on the code flow.
 *
 * | Error | Description |
 * | ----- | ----------- |
 * | `invalid_code` | The code is invalid. |
 * | `invalid_claim` | The _claim_, email or phone number, is invalid. |
 */
export type CodeProviderError =
  | {
      type: "invalid_code"
    }
  | {
      type: "invalid_claim"
      key: string
      value: string
    }

export function CodeProvider<
  Claims extends Record<string, string> = Record<string, string>,
>(config: CodeProviderConfig<Claims>): Provider<{ claims: Claims }> {
  const length = config.length || 6
  function generate() {
    return generateUnbiasedDigits(length)
  }

  return {
    type: "code",
    init(options: ProviderOptions<{ claims: Claims }>) {
      /**
       * Helper to transition to a new state and render the UI.
       */
      const transition = (
        next: CodeProviderState,
        fd?: Map<string, string>,
        err?: CodeProviderError,
      ) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          const cookieValue = yield* options.setCookie(
            "provider",
            60 * 60 * 24,
            next,
          )
          const resp = yield* tryProviderCallback(
            "Code provider request UI failed",
            () => config.request(request, next, fd, err),
          )
          return HttpServerResponse.raw(resp).pipe(
            HttpServerResponse.setHeader("Set-Cookie", cookieValue),
          )
        })

      // GET /authorize - Start code flow
      const authorizeHandler = transition({ type: "start" })

      // POST /authorize - Handle form submission
      const postHandler = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const code = generate()
        const urlParams = yield* request.urlParamsBody.pipe(
          Effect.catchAll(() => Effect.succeed([] as const)),
        )
        const fd = new Map<string, string>()
        for (const [key, value] of urlParams) {
          fd.set(key, value)
        }

        const state = yield* options.getCookie<CodeProviderState>("provider")
        const action = fd.get("action")

        if (action === "request" || action === "resend") {
          const claims = Object.fromEntries(fd) as Claims
          delete claims["action"]
          const err = yield* tryProviderCallback(
            "Code provider sendCode failed",
            () => config.sendCode(claims, code),
          )
          if (err) {
            return yield* transition({ type: "start" }, fd, err)
          }
          return yield* transition(
            {
              type: "code",
              resend: action === "resend",
              claims,
              code,
            },
            fd,
          )
        }

        if (action === "verify" && state?.type === "code") {
          const compare = fd.get("code")
          if (
            !state.code ||
            !compare ||
            !timingSafeCompare(state.code, compare)
          ) {
            return yield* transition(
              {
                ...state,
                resend: false,
              },
              fd,
              { type: "invalid_code" },
            )
          }
          yield* options.deleteCookie("provider")
          return yield* options.success({ claims: state.claims as Claims })
        }

        // Default: return to start state
        return yield* transition({ type: "start" }, fd)
      })

      return HttpRouter.empty.pipe(
        HttpRouter.get("/authorize", authorizeHandler),
        HttpRouter.post("/authorize", postHandler),
      )
    },
  }
}

/**
 * @internal
 */
export type CodeProviderOptions = Parameters<typeof CodeProvider>[0]
