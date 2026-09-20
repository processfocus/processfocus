import { randomBytes } from "node:crypto"
import { Effect } from "effect"
import { credentialDeadline } from "./credential-deadline"

interface CallbackTokens {
  accessToken: string
  expiresAt: number
}

interface CallbackServer {
  port: number
  state: string
  tokens: Promise<CallbackTokens>
  stop: () => void
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

/**
 * Start an ephemeral HTTP server on an OS-assigned port to receive
 * the OAuth callback from the browser.
 *
 * Returns the port number and a Promise that resolves with the access
 * token once the callback is received. The timeout is owned here so
 * it can be cleared immediately on success, preventing the timer from
 * keeping the process alive.
 */
export const startCallbackServer = Effect.sync((): CallbackServer => {
  const state = randomBytes(32).toString("base64url")
  const {
    promise: tokens,
    resolve: resolveTokens,
    reject: rejectTokens,
  } = Promise.withResolvers<CallbackTokens>()
  // The browser launcher may still be running when a failed callback arrives.
  void tokens.catch(() => {})
  let settled = false

  const fail = (message: string): Response => {
    settled = true
    clearTimeout(timeoutId)
    rejectTokens(new Error(message))
    return new Response(message, {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    })
  }

  const server = Bun.serve({
    hostname: "localhost",
    port: 0,
    fetch(request: Request) {
      const url = new URL(request.url)

      if (url.pathname === "/callback") {
        if (settled) {
          return new Response("Login callback already completed", {
            status: 409,
          })
        }
        const accessToken = url.searchParams.get("access_token")
        const expiresIn = Number(url.searchParams.get("expires_in"))
        const returnedState = url.searchParams.get("state")

        if (returnedState !== state) {
          return fail("Invalid login callback state")
        }

        if (url.searchParams.has("error")) {
          return fail(
            url.searchParams.get("error") === "expired"
              ? "Login expired. Run pfcli auth login again."
              : "Login failed. Run pfcli auth login again.",
          )
        }

        if (accessToken) {
          let expiresAt: number
          try {
            expiresAt = credentialDeadline(accessToken, expiresIn)
          } catch (error) {
            return fail(
              error instanceof Error
                ? error.message
                : "Invalid login credential expiry",
            )
          }
          settled = true
          clearTimeout(timeoutId)
          resolveTokens({
            accessToken,
            expiresAt,
          })

          return new Response(SUCCESS_HTML, {
            headers: {
              "Content-Type": "text/html",
              "Cache-Control": "no-store",
            },
          })
        }

        return fail("Missing access token")
      }

      return new Response("Not found", { status: 404 })
    },
  })

  const timeoutId = setTimeout(
    () => {
      settled = true
      rejectTokens(new Error("Login timed out after 2 minutes"))
    },
    2 * 60 * 1000,
  )

  return {
    port: server.port as number,
    state,
    tokens,
    stop: () => {
      clearTimeout(timeoutId)
      server.stop()
    },
  }
})
