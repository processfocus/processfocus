import { Console, DateTime, Effect } from "effect"
import { AuthError } from "../../errors"
import { writeCredentials } from "../../utils/credentials"
import { openBrowser, validateBrowserUrl } from "../../utils/open-browser"
import { startCallbackServer } from "./callback-server"

export const runAuthLogin = (baseUrl: string) =>
  Effect.gen(function* () {
    const loginUrl = yield* Effect.try({
      try: () => validateBrowserUrl(new URL("/cli-auth", baseUrl).toString()),
      catch: (cause) =>
        new AuthError({
          message: cause instanceof Error ? cause.message : "Invalid login URL",
          cause,
        }),
    })

    const server = yield* startCallbackServer
    loginUrl.searchParams.set("port", String(server.port))
    loginUrl.searchParams.set("state", server.state)

    yield* openBrowser(loginUrl.toString())
    yield* Console.log("Waiting for login...")

    const tokens = yield* Effect.tryPromise({
      try: () => server.tokens,
      catch: (cause) =>
        new AuthError({
          message: cause instanceof Error ? cause.message : String(cause),
          cause,
        }),
    }).pipe(Effect.ensuring(Effect.sync(server.stop)))

    const loginAt = yield* DateTime.now
    const expiresAt = DateTime.add(loginAt, { seconds: tokens.expiresIn })

    yield* Effect.try({
      try: () =>
        writeCredentials({
          version: 1,
          baseUrl,
          accessToken: tokens.accessToken,
          expiresAt: DateTime.formatIso(expiresAt),
          loginAt: DateTime.formatIso(loginAt),
        }),
      catch: (cause) =>
        new AuthError({ message: "Failed to write credentials", cause }),
    })

    yield* Console.log("Login successful! Credentials stored.")
  })
