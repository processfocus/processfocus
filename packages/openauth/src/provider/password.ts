/**
 * Configures a provider that supports username and password authentication. This is usually
 * paired with the `PasswordUI`.
 *
 * ```ts
 * import { PasswordUI } from "@openauthjs/openauth/ui/password"
 * import { PasswordProvider } from "@openauthjs/openauth/provider/password"
 *
 * export default issuer({
 *   providers: {
 *     password: PasswordProvider(
 *       PasswordUI({
 *         copy: {
 *           error_email_taken: "This email is already taken."
 *         },
 *         sendCode: (email, code) => console.log(email, code)
 *       })
 *     )
 *   },
 *   // ...
 * })
 * ```
 *
 * Behind the scenes, the `PasswordProvider` expects callbacks that implements request handlers
 * that generate the UI for the following.
 *
 * ```ts
 * PasswordProvider({
 *   // ...
 *   login: (req, form, error) => Promise<Response>
 *   register: (req, state, form, error) => Promise<Response>
 *   change: (req, state, form, error) => Promise<Response>
 * })
 * ```
 *
 * This allows you to create your own UI for each of these screens.
 *
 * @packageDocumentation
 */

import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform"
import type { StandardSchemaV1 } from "@standard-schema/spec"
import { Effect, Runtime } from "effect"
import { UnknownStateError } from "../error.js"
import { generateUnbiasedDigits, timingSafeCompare } from "../random.js"
import { getRelativeUrl } from "../request.js"
import { errorJson } from "../response.js"
import { Storage, StorageService } from "../storage/storage.js"
import {
  type Provider,
  type ProviderOptions,
  tryProviderCallback,
} from "./provider.js"

/**
 * @internal
 */
export interface PasswordHasher<T> {
  hash(password: string): Promise<T>
  verify(password: string, compare: T): Promise<boolean>
}

export interface PasswordConfig {
  /**
   * @internal
   */
  length?: number
  /**
   * @internal
   */
  hasher?: PasswordHasher<any>
  /**
   * The request handler to generate the UI for the login screen.
   *
   * Takes the standard [`Request`](https://developer.mozilla.org/en-US/docs/Web/API/Request)
   * and optionally form data as a Map<string, string>
   * ojects.
   *
   * In case of an error, this is called again with the `error`.
   *
   * Expects the [`Response`](https://developer.mozilla.org/en-US/docs/Web/API/Response) object
   * in return.
   */
  login: (
    req: HttpServerRequest.HttpServerRequest,
    form?: Map<string, string>,
    error?: PasswordLoginError,
  ) => Promise<Response>
  /**
   * The request handler to generate the UI for the register screen.
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
  register: (
    req: HttpServerRequest.HttpServerRequest,
    state: PasswordRegisterState,
    form?: Map<string, string>,
    error?: PasswordRegisterError,
  ) => Promise<Response>
  /**
   * The request handler to generate the UI for the change password screen.
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
  change: (
    req: HttpServerRequest.HttpServerRequest,
    state: PasswordChangeState,
    form?: Map<string, string>,
    error?: PasswordChangeError,
  ) => Promise<Response>
  /**
   * Callback to send the confirmation pin code to the user.
   *
   * @example
   * ```ts
   * {
   *   sendCode: async (email, code) => {
   *     // Send an email with the code
   *   }
   * }
   * ```
   */
  sendCode: (email: string, code: string) => Promise<void>
  /**
   * Callback to validate the password on sign up and password reset.
   *
   * @example
   * ```ts
   * {
   *   validatePassword: (password) => {
   *      return password.length < 8 ? "Password must be at least 8 characters" : undefined
   *   }
   * }
   * ```
   */
  validatePassword?:
    | StandardSchemaV1
    | ((password: string) => Promise<string | undefined> | string | undefined)
}

/**
 * The states that can happen on the register screen.
 *
 * | State | Description |
 * | ----- | ----------- |
 * | `start` | The user is asked to enter their email address and password to start the flow. |
 * | `code` | The user needs to enter the pin code to verify their email. |
 */
export type PasswordRegisterState =
  | {
      type: "start"
    }
  | {
      type: "code"
      code: string
      email: string
      password: string
    }

/**
 * The errors that can happen on the register screen.
 *
 * | Error | Description |
 * | ----- | ----------- |
 * | `email_taken` | The email is already taken. |
 * | `invalid_email` | The email is invalid. |
 * | `invalid_code` | The code is invalid. |
 * | `invalid_password` | The password is invalid. |
 * | `password_mismatch` | The passwords do not match. |
 */
export type PasswordRegisterError =
  | {
      type: "invalid_code"
    }
  | {
      type: "email_taken"
    }
  | {
      type: "invalid_email"
    }
  | {
      type: "invalid_password"
    }
  | {
      type: "password_mismatch"
    }
  | {
      type: "validation_error"
      message?: string
    }

/**
 * The state of the password change flow.
 *
 * | State | Description |
 * | ----- | ----------- |
 * | `start` | The user is asked to enter their email address to start the flow. |
 * | `code` | The user needs to enter the pin code to verify their email. |
 * | `update` | The user is asked to enter their new password and confirm it. |
 */
export type PasswordChangeState =
  | {
      type: "start"
      redirect: string
    }
  | {
      type: "code"
      code: string
      email: string
      redirect: string
    }
  | {
      type: "update"
      redirect: string
      email: string
    }

/**
 * The errors that can happen on the change password screen.
 *
 * | Error | Description |
 * | ----- | ----------- |
 * | `invalid_email` | The email is invalid. |
 * | `invalid_code` | The code is invalid. |
 * | `invalid_password` | The password is invalid. |
 * | `password_mismatch` | The passwords do not match. |
 */
export type PasswordChangeError =
  | {
      type: "invalid_email"
    }
  | {
      type: "invalid_code"
    }
  | {
      type: "invalid_password"
    }
  | {
      type: "password_mismatch"
    }
  | {
      type: "validation_error"
      message: string
    }

/**
 * The errors that can happen on the login screen.
 *
 * | Error | Description |
 * | ----- | ----------- |
 * | `invalid_email` | The email is invalid. |
 * | `invalid_password` | The password is invalid. |
 */
export type PasswordLoginError =
  | {
      type: "invalid_password"
    }
  | {
      type: "invalid_email"
    }



export function PasswordProvider(
  config: PasswordConfig,
): Provider<{ email: string }> {
  const hasher = config.hasher ?? ScryptHasher()
  function generate() {
    return generateUnbiasedDigits(6)
  }
  const rawWithCookie = (cookieValue: string, resp: Response) =>
    HttpServerResponse.raw(resp).pipe(
      HttpServerResponse.setHeader("Set-Cookie", cookieValue),
    )
  return {
    type: "password",
    init(options: ProviderOptions<{ email: string }>) {
      // GET /authorize - Show login screen
      const authorizeGetHandler = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const resp = yield* tryProviderCallback(
          "Password provider login UI failed",
          () => config.login(request),
        )
        return HttpServerResponse.raw(resp)
      })

      // POST /authorize - Handle login form submission
      const authorizePostHandler = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const urlParams = yield* request.urlParamsBody.pipe(
          Effect.catchAll(() => Effect.succeed([] as const)),
        )
        const fd = new Map<string, string>()
        for (const [key, value] of urlParams) {
          fd.set(key, value)
        }

        const error = (err: PasswordLoginError) =>
          Effect.gen(function* () {
            const resp = yield* tryProviderCallback(
              "Password provider login UI failed",
              () => config.login(request, fd, err),
            )
            return HttpServerResponse.raw(resp)
          })

        const email = fd.get("email")?.toLowerCase()
        if (!email) return yield* error({ type: "invalid_email" })
        const storage = yield* StorageService
        const runtime = yield* Effect.runtime<never>()
        const runPromise = Runtime.runPromise(runtime)
        const hash = yield* storage.get<HashedPassword>([
          "email",
          email,
          "password",
        ])
        const password = fd.get("password")
        if (
          !password ||
          !hash ||
          !(yield* tryProviderCallback(
            "Password provider hasher.verify failed",
            () => hasher.verify(password, hash),
          ))
        )
          return yield* error({ type: "invalid_password" })
        // Store the email->subject mapping for invalidation tracking
        return yield* options.success(
          {
            email: email,
          },
          {
            invalidate: async (subject) => {
              await runPromise(
                storage.set(["email", email, "subject"], subject),
              )
            },
          },
        )
      })

      // GET /register - Show register screen
      const registerGetHandler = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const state: PasswordRegisterState = {
          type: "start",
        }
        const cookieValue = yield* options.setCookie(
          "provider",
          60 * 60 * 24,
          state,
        )
        const resp = yield* tryProviderCallback(
          "Password provider register UI failed",
          () => config.register(request, state),
        )
        return rawWithCookie(cookieValue, resp)
      })

      // POST /register - Handle register form submission
      const registerPostHandler = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const urlParams = yield* request.urlParamsBody.pipe(
          Effect.catchAll(() => Effect.succeed([] as const)),
        )
        const fd = new Map<string, string>()
        for (const [key, value] of urlParams) {
          fd.set(key, value)
        }

        const email = fd.get("email")?.toLowerCase()
        const action = fd.get("action")
        const provider =
          yield* options.getCookie<PasswordRegisterState>("provider")

        const transition = (
          next: PasswordRegisterState,
          err?: PasswordRegisterError,
        ) =>
          Effect.gen(function* () {
            const cookieValue = yield* options.setCookie(
              "provider",
              60 * 60 * 24,
              next,
            )
            const resp = yield* tryProviderCallback(
              "Password provider register UI failed",
              () => config.register(request, next, fd, err),
            )
            return rawWithCookie(cookieValue, resp)
          })

        if (!provider) {
          return yield* transition({ type: "start" })
        }

        if (action === "register" && provider.type === "start") {
          const password = fd.get("password")
          const repeat = fd.get("repeat")
          if (!email) return yield* transition(provider, { type: "invalid_email" })
          if (!password)
            return yield* transition(provider, { type: "invalid_password" })
          if (password !== repeat)
            return yield* transition(provider, { type: "password_mismatch" })
          if (config.validatePassword) {
            const validationError = yield* Effect.promise(async () => {
              try {
                if (typeof config.validatePassword === "function") {
                  return await config.validatePassword(password)
                } else {
                  const res =
                    await config.validatePassword!["~standard"].validate(
                      password,
                    )

                  if (res.issues?.length) {
                    throw new Error(
                      res.issues.map((issue) => issue.message).join(", "),
                    )
                  }
                  return undefined
                }
              } catch (error) {
                return error instanceof Error ? error.message : undefined
              }
            })
            if (validationError)
              return yield* transition(provider, {
                type: "validation_error",
                message: validationError,
              })
          }
          const existing = yield* Storage.get(["email", email, "password"])
          if (existing) return yield* transition(provider, { type: "email_taken" })
          const code = generate()
          yield* tryProviderCallback(
            "Password provider sendCode failed",
            () => config.sendCode(email, code),
          )
          return yield* transition({
            type: "code",
            code,
            password: yield* tryProviderCallback(
              "Password provider hasher.hash failed",
              () => hasher.hash(password),
            ),
            email,
          })
        }

        if (action === "register" && provider.type === "code") {
          const code = generate()
          yield* tryProviderCallback(
            "Password provider sendCode failed",
            () => config.sendCode(provider.email, code),
          )
          return yield* transition({
            type: "code",
            code,
            password: provider.password,
            email: provider.email,
          })
        }

        if (action === "verify" && provider.type === "code") {
          const code = fd.get("code")
          if (!code || !timingSafeCompare(code, provider.code))
            return yield* transition(provider, { type: "invalid_code" })
          const existing = yield* Storage.get([
            "email",
            provider.email,
            "password",
          ])
          if (existing)
            return yield* transition({ type: "start" }, { type: "email_taken" })
          yield* Storage.set(
            ["email", provider.email, "password"],
            provider.password,
          )
          return yield* options.success({
            email: provider.email,
          })
        }

        return yield* transition({ type: "start" })
      })

      // GET /change - Show change password screen
      const changeGetHandler = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url)
        const redirect =
          url.searchParams.get("redirect_uri") ||
          (yield* getRelativeUrl(request, "./authorize"))
        const state: PasswordChangeState = {
          type: "start",
          redirect,
        }
        const cookieValue = yield* options.setCookie(
          "provider",
          60 * 60 * 24,
          state,
        )
        const resp = yield* tryProviderCallback(
          "Password provider change UI failed",
          () => config.change(request, state),
        )
        return rawWithCookie(cookieValue, resp)
      }).pipe(
        Effect.catchTag("@pf/openauth/MissingHostError", (error) =>
          errorJson("server_error", error.description, 500),
        ),
      )

      // POST /change - Handle change password form submission
      const changePostHandler = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const urlParams = yield* request.urlParamsBody.pipe(
          Effect.catchAll(() => Effect.succeed([] as const)),
        )
        const fd = new Map<string, string>()
        for (const [key, value] of urlParams) {
          fd.set(key, value)
        }

        const action = fd.get("action")
        const provider =
          yield* options.getCookie<PasswordChangeState>("provider")
        if (!provider) throw new UnknownStateError()

        const transition = (
          next: PasswordChangeState,
          err?: PasswordChangeError,
        ) =>
          Effect.gen(function* () {
            const cookieValue = yield* options.setCookie(
              "provider",
              60 * 60 * 24,
              next,
            )
            const resp = yield* tryProviderCallback(
              "Password provider change UI failed",
              () => config.change(request, next, fd, err),
            )
            return rawWithCookie(cookieValue, resp)
          })

        if (action === "code") {
          const email = fd.get("email")?.toLowerCase()
          if (!email)
            return yield* transition(
              { type: "start", redirect: provider.redirect },
              { type: "invalid_email" },
            )
          const code = generate()
          yield* tryProviderCallback(
            "Password provider sendCode failed",
            () => config.sendCode(email, code),
          )

          return yield* transition({
            type: "code",
            code,
            email,
            redirect: provider.redirect,
          })
        }

        if (action === "verify" && provider.type === "code") {
          const code = fd.get("code")
          if (!code || !timingSafeCompare(code, provider.code))
            return yield* transition(provider, { type: "invalid_code" })
          return yield* transition({
            type: "update",
            email: provider.email,
            redirect: provider.redirect,
          })
        }

        if (action === "update" && provider.type === "update") {
          const existing = yield* Storage.get([
            "email",
            provider.email,
            "password",
          ])
          if (!existing)
            return HttpServerResponse.redirect(provider.redirect, {
              status: 302,
            })

          const password = fd.get("password")
          const repeat = fd.get("repeat")
          if (!password)
            return yield* transition(provider, { type: "invalid_password" })
          if (password !== repeat)
            return yield* transition(provider, { type: "password_mismatch" })

          if (config.validatePassword) {
            const validationError = yield* Effect.promise(async () => {
              try {
                if (typeof config.validatePassword === "function") {
                  return await config.validatePassword(password)
                } else {
                  const res =
                    await config.validatePassword!["~standard"].validate(
                      password,
                    )

                  if (res.issues?.length) {
                    throw new Error(
                      res.issues.map((issue) => issue.message).join(", "),
                    )
                  }
                  return undefined
                }
              } catch (error) {
                return error instanceof Error ? error.message : undefined
              }
            })
            if (validationError)
              return yield* transition(provider, {
                type: "validation_error",
                message: validationError,
              })
          }

          const hashedPassword = yield* tryProviderCallback(
            "Password provider hasher.hash failed",
            () => hasher.hash(password),
          )
          yield* Storage.set(
            ["email", provider.email, "password"],
            hashedPassword,
          )
          const subject = yield* Storage.get<string>([
            "email",
            provider.email,
            "subject",
          ])
          if (subject) yield* options.invalidate(subject)

          return HttpServerResponse.redirect(provider.redirect, { status: 302 })
        }

        return yield* transition({ type: "start", redirect: provider.redirect })
      })

      return HttpRouter.empty.pipe(
        HttpRouter.get("/authorize", authorizeGetHandler),
        HttpRouter.post("/authorize", authorizePostHandler),
        HttpRouter.get("/register", registerGetHandler),
        HttpRouter.post("/register", registerPostHandler),
        HttpRouter.get("/change", changeGetHandler),
        HttpRouter.post("/change", changePostHandler),
      )
    },
  }
}

import { TextEncoder } from "node:util"
import * as jose from "jose"

type HashedPassword = {}

/**
 * @internal
 */
export function PBKDF2Hasher(opts?: { iterations?: number }): PasswordHasher<{
  hash: string
  salt: string
  iterations: number
}> {
  const iterations = opts?.iterations ?? 600000
  return {
    async hash(password) {
      const encoder = new TextEncoder()
      const bytes = encoder.encode(password)
      const salt = crypto.getRandomValues(new Uint8Array(16))
      const keyMaterial = await crypto.subtle.importKey(
        "raw",
        bytes,
        "PBKDF2",
        false,
        ["deriveBits"],
      )
      const hash = await crypto.subtle.deriveBits(
        {
          name: "PBKDF2",
          hash: "SHA-256",
          salt: salt,
          iterations,
        },
        keyMaterial,
        256,
      )
      const hashBase64 = jose.base64url.encode(new Uint8Array(hash))
      const saltBase64 = jose.base64url.encode(salt)
      return {
        hash: hashBase64,
        salt: saltBase64,
        iterations,
      }
    },
    async verify(password, compare) {
      const encoder = new TextEncoder()
      const passwordBytes = encoder.encode(password)
      const salt = jose.base64url.decode(compare.salt)
      const params = {
        name: "PBKDF2",
        hash: "SHA-256",
        salt,
        iterations: compare.iterations,
      }
      const keyMaterial = await crypto.subtle.importKey(
        "raw",
        passwordBytes,
        "PBKDF2",
        false,
        ["deriveBits"],
      )
      const hash = await crypto.subtle.deriveBits(params, keyMaterial, 256)
      const hashBase64 = jose.base64url.encode(new Uint8Array(hash))
      return hashBase64 === compare.hash
    },
  }
}

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto"

/**
 * @internal
 */
export function ScryptHasher(opts?: {
  N?: number
  r?: number
  p?: number
}): PasswordHasher<{
  hash: string
  salt: string
  N: number
  r: number
  p: number
}> {
  const N = opts?.N ?? 16384
  const r = opts?.r ?? 8
  const p = opts?.p ?? 1

  return {
    async hash(password) {
      const salt = randomBytes(16)
      const keyLength = 32 // 256 bits

      const derivedKey = await new Promise<Buffer>((resolve, reject) => {
        scrypt(password, salt, keyLength, { N, r, p }, (err, derivedKey) => {
          if (err) reject(err)
          else resolve(derivedKey)
        })
      })

      const hashBase64 = derivedKey.toString("base64")
      const saltBase64 = salt.toString("base64")

      return {
        hash: hashBase64,
        salt: saltBase64,
        N,
        r,
        p,
      }
    },

    async verify(password, compare) {
      const salt = Buffer.from(compare.salt, "base64")
      const keyLength = 32 // 256 bits

      const derivedKey = await new Promise<Buffer>((resolve, reject) => {
        scrypt(
          password,
          salt,
          keyLength,
          { N: compare.N, r: compare.r, p: compare.p },
          (err, derivedKey) => {
            if (err) reject(err)
            else resolve(derivedKey)
          },
        )
      })

      return timingSafeEqual(derivedKey, Buffer.from(compare.hash, "base64"))
    },
  }
}
