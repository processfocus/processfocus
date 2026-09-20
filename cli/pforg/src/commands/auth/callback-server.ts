import { randomBytes } from "node:crypto"
import { Effect } from "effect"
import { AuthError } from "../../errors"

interface CallbackTokens {
  readonly accessToken: string
  readonly expiresIn: number
}

interface CallbackServer {
  readonly port: number
  readonly state: string
  readonly tokens: Promise<CallbackTokens>
  readonly stop: () => void
}

const SUCCESS_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>Login Successful</title>
  <style>
    body {
      font-family: system-ui, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100vh;
      margin: 0;
      background: #fff;
      color: #111;
    }
    @media (prefers-color-scheme: dark) {
      body { background: #111; color: #eee; }
    }
  </style>
</head>
<body>
  <div style="text-align: center;">
    <h1>Login successful!</h1>
    <p>You can close this tab.</p>
  </div>
</body>
</html>`

export const startCallbackServer: Effect.Effect<CallbackServer, AuthError> =
  Effect.try({
    try: () => {
      const state = randomBytes(32).toString("base64url")
      const {
        promise: tokens,
        resolve: resolveTokens,
        reject: rejectTokens,
      } = Promise.withResolvers<CallbackTokens>()

      const server = Bun.serve({
        hostname: "localhost",
        port: 0,
        fetch(request: Request) {
          const url = new URL(request.url)
          if (url.pathname !== "/callback") {
            return new Response("Not found", { status: 404 })
          }

          const returnedState = url.searchParams.get("state")
          if (returnedState !== state) {
            clearTimeout(timeoutId)
            rejectTokens(new Error("Invalid login callback state"))
            return new Response("Invalid state", { status: 400 })
          }

          const accessToken = url.searchParams.get("access_token")
          const expiresIn = Number(url.searchParams.get("expires_in"))
          if (
            !accessToken ||
            !Number.isFinite(expiresIn) ||
            !Number.isInteger(expiresIn) ||
            expiresIn <= 0
          ) {
            clearTimeout(timeoutId)
            rejectTokens(new Error("Invalid login callback credentials"))
            return new Response("Invalid callback credentials", {
              status: 400,
            })
          }

          clearTimeout(timeoutId)
          resolveTokens({ accessToken, expiresIn })
          return new Response(SUCCESS_HTML, {
            headers: { "Content-Type": "text/html" },
          })
        },
      })

      const port = server.port
      if (port === undefined) {
        server.stop()
        throw new Error("Callback server did not bind a port")
      }
      const timeoutId = setTimeout(
        () => rejectTokens(new Error("Login timed out after 2 minutes")),
        2 * 60 * 1000,
      )

      return {
        port,
        state,
        tokens,
        stop: () => {
          clearTimeout(timeoutId)
          server.stop()
        },
      }
    },
    catch: (cause) =>
      new AuthError({
        message: "Failed to start login callback server",
        cause,
      }),
  })
