import { Console, Effect } from "effect"
import { AuthLoginError } from "../../errors"
import {
  readWorkloadCredentials,
  writeCredentials,
} from "../../utils/credentials"
import { openBrowser, validateBrowserUrl } from "../../utils/open-browser"
import { startCallbackServer } from "./callback-server"

const writeLoginCredentials = (
  baseUrl: string,
  accessToken: string,
  deadline: number,
) =>
  Effect.try({
    try: () => {
      const now = Date.now()
      const expiresAt = new Date(deadline)
      if (deadline <= now) {
        throw new AuthLoginError({
          message: "Login expired. Run pfcli auth login again.",
        })
      }
      writeCredentials({
        version: 1,
        baseUrl,
        accessToken,
        expiresAt: expiresAt.toISOString(),
        loginAt: new Date(now).toISOString(),
      })
    },
    catch: (error) =>
      error instanceof AuthLoginError
        ? error
        : new AuthLoginError({
            message: "Failed to write credentials",
            cause: error,
          }),
  })

/**
 * `pfcli auth login` — browser OAuth login or direct GitHub OIDC machine login.
 *
 * 1. Starts an ephemeral callback server on a random port
 * 2. Opens the browser to {BASE_URL}/cli-auth?port={port}
 * 3. Waits for the callback with tokens (2-min timeout)
 * 4. Stores credentials to ~/.config/pf/credentials.json
 */
export const runAuthLogin = (baseUrl: string) =>
  Effect.gen(function* () {
    if (process.env["PFCLI_CI_PROVIDER_USER"] !== undefined)
      return yield* new AuthLoginError({
        message: "Named-user CI login is retired. Use normal browser login.",
      })
    if (
      process.env["PFCLI_AUTH_MODE"] ||
      process.env["PFCLI_WORKLOAD_PROVIDER_USER"] !== undefined
    ) {
      yield* readWorkloadCredentials()
      yield* Console.log(
        "GitHub Actions OIDC federation authentication successful. Credentials remain in memory; each command acquires its own credentials.",
      )
      return
    }
    const loginUrl = yield* Effect.try({
      try: () => validateBrowserUrl(new URL("/cli-auth", baseUrl).toString()),
      catch: (cause) =>
        new AuthLoginError({
          message: cause instanceof Error ? cause.message : "Invalid login URL",
          cause,
        }),
    })

    const tokens = yield* Effect.acquireUseRelease(
      startCallbackServer,
      (server) =>
        Effect.gen(function* () {
          loginUrl.searchParams.set("port", String(server.port))
          loginUrl.searchParams.set("state", server.state)

          yield* openBrowser(loginUrl.toString())
          yield* Console.log("Waiting for login...")

          return yield* Effect.tryPromise({
            try: () => server.tokens,
            catch: (error) =>
              new AuthLoginError({
                message: error instanceof Error ? error.message : String(error),
                cause: error,
              }),
          })
        }),
      (server) => Effect.sync(() => server.stop()),
    )

    yield* writeLoginCredentials(baseUrl, tokens.accessToken, tokens.expiresAt)

    yield* Console.log("Login successful! Credentials stored.")
  })
