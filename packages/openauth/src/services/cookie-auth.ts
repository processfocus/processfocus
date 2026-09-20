/**
 * Cookie authentication service for encrypted cookie management.
 * Handles setting, getting, and invalidating authentication cookies.
 * @packageDocumentation
 */
import { Context, Effect, Layer, Stream } from "effect"
import { serializeCookie } from "../http-middleware/cookies"
import { Storage, type StorageError, StorageService } from "../storage/storage"
import { EncryptionService } from "./encryption"
import type { NoEncryptionKeysError } from "./key-management"

/**
 * Service interface for cookie authentication operations.
 */
export interface CookieAuthServiceInterface {
  /**
   * Set an encrypted cookie value.
   * @param key - Cookie name
   * @param maxAge - Cookie max age in seconds
   * @param value - Value to encrypt and store
   * @param isSecure - Whether the request is over HTTPS
   * @returns The Set-Cookie header value
   */
  readonly set: (
    key: string,
    maxAge: number,
    value: unknown,
    isSecure: boolean,
  ) => Effect.Effect<string, StorageError | NoEncryptionKeysError>
  /**
   * Get and decrypt a cookie value.
   * @param cookieHeader - The Cookie header from the request
   * @param key - Cookie name to retrieve
   * @returns The decrypted value or undefined if not found
   */
  readonly get: (
    cookieHeader: string,
    key: string,
  ) => Effect.Effect<unknown | undefined, StorageError | NoEncryptionKeysError>
  /**
   * Create a Set-Cookie header to unset a cookie.
   * @param key - Cookie name to unset
   * @returns The Set-Cookie header value
   */
  readonly unset: (key: string) => Effect.Effect<string>
  /**
   * Invalidate all refresh tokens for a subject.
   * @param subject - The subject identifier
   */
  readonly invalidate: (subject: string) => Effect.Effect<void, StorageError>
}

/**
 * Effect service tag for cookie authentication.
 */
export class CookieAuthService extends Context.Tag(
  "@pf/openauth/CookieAuthService",
)<CookieAuthService, CookieAuthServiceInterface>() {}

/**
 * Live implementation of CookieAuthService.
 */
export const CookieAuthServiceLive: Layer.Layer<
  CookieAuthService,
  never,
  EncryptionService | StorageService
> = Layer.effect(
  CookieAuthService,
  Effect.gen(function* () {
    const encryption = yield* EncryptionService
    const storageImpl = yield* StorageService
    const storageLayer = Layer.succeed(StorageService, storageImpl)

    return {
      set: (key: string, maxAge: number, value: unknown, isSecure: boolean) =>
        Effect.gen(function* () {
          const encrypted = yield* encryption.encrypt(value)
          return serializeCookie(key, encrypted, {
            maxAge,
            httpOnly: true,
            secure: isSecure,
            sameSite: isSecure ? "none" : "lax",
          })
        }),

      get: (cookieHeader: string, key: string) =>
        Effect.gen(function* () {
          const cookies = Object.fromEntries(
            cookieHeader.split(";").map((c) => {
              const [k, ...v] = c.trim().split("=")
              return [k, v.join("=")]
            }),
          )
          const raw = cookies[key]
          if (!raw) return undefined

          return yield* encryption.decrypt(raw).pipe(
            Effect.tapError((ex) =>
              Effect.logError("Failed to decrypt cookie").pipe(
                Effect.annotateLogs({ key, error: ex }),
              ),
            ),
            Effect.orElseSucceed(() => undefined),
          )
        }),

      unset: (key: string) =>
        Effect.succeed(
          serializeCookie(key, "", {
            maxAge: 0,
            expires: new Date(0),
          }),
        ),

      invalidate: (subject: string) =>
        Effect.gen(function* () {
          const keys: string[][] = []
          yield* Storage.scan<unknown>(["oauth:refresh", subject]).pipe(
            Stream.runForEach(([key]) =>
              Effect.sync(() => {
                keys.push(key)
              }),
            ),
          )
          for (const key of keys) {
            yield* Storage.remove(key)
          }
        }).pipe(Effect.provide(storageLayer)),
    }
  }),
)
