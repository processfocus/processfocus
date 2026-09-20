import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "@effect/platform"
import type { OAuth2Tokens } from "arctic"
import { Effect } from "effect"
import { OauthError } from "../error.js"
import { getRelativeUrl } from "../request.js"
import { errorJson } from "../response.js"
import type { Provider, ProviderOptions } from "./provider.js"

export interface ArcticProviderOptions {
  scopes: string[]
  clientID: string
  clientSecret: string
  query?: Record<string, string>
}

interface ProviderState {
  state: string
}

export function ArcticProvider(
  providerClass: new (
    clientID: string,
    clientSecret: string,
    callback: string,
  ) => {
    createAuthorizationURL(state: string, scopes: string[]): URL
    validateAuthorizationCode(code: string): Promise<OAuth2Tokens>
    refreshAccessToken(refreshToken: string): Promise<OAuth2Tokens>
  },
  config: ArcticProviderOptions,
): Provider<{
  tokenset: OAuth2Tokens
}> {
  const getClient = (request: HttpServerRequest.HttpServerRequest) =>
    Effect.gen(function* () {
      const url = new URL(request.url)
      const pathname = url.pathname.replace(/authorize.*$/, "callback")
      const callbackUrl = yield* getRelativeUrl(request, pathname)
      return new providerClass(config.clientID, config.clientSecret, callbackUrl)
    })

  return {
    type: "arctic",
    init(options: ProviderOptions<{ tokenset: OAuth2Tokens }>) {
      // GET /authorize - Start OAuth flow
      const authorizeHandler = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const client = yield* getClient(request)
        const state = crypto.randomUUID()

        const cookieValue = yield* options.setCookie("provider", 60 * 10, { state } as ProviderState)

        const authUrl = client.createAuthorizationURL(state, config.scopes)
        return HttpServerResponse.redirect(authUrl.toString(), { status: 302 }).pipe(
          HttpServerResponse.setHeader("Set-Cookie", cookieValue),
        )
      }).pipe(
        Effect.catchTag("@pf/openauth/MissingHostError", (error) =>
          errorJson("server_error", error.description, 500),
        ),
      )

      // GET /callback - Handle OAuth callback
      const callbackHandler = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const client = yield* getClient(request)
        const url = new URL(request.url)
        const providerState = yield* options.getCookie<ProviderState>("provider")

        if (!providerState) {
          return HttpServerResponse.redirect(yield* getRelativeUrl(request, "./authorize"), {
            status: 302,
          })
        }

        const code = url.searchParams.get("code")
        const state = url.searchParams.get("state")

        if (!code) {
          return yield* Effect.fail(new OauthError("invalid_request", "Missing code"))
        }
        if (state !== providerState.state) {
          return yield* Effect.fail(new OauthError("invalid_request", "Invalid state"))
        }

        const tokens = yield* Effect.tryPromise({
          try: () => client.validateAuthorizationCode(code),
          catch: () => new OauthError("server_error", "Token validation failed"),
        })

        return yield* options.success({ tokenset: tokens })
      }).pipe(
        Effect.catchAll((error) =>
          Effect.gen(function* () {
            yield* Effect.logError("Arctic callback failed").pipe(
              Effect.annotateLogs({ error: String(error) }),
            )
            return yield* errorJson("server_error", "Arctic callback failed", 500)
          }),
        ),
      )

      return HttpRouter.empty.pipe(
        HttpRouter.get("/authorize", authorizeHandler),
        HttpRouter.get("/callback", callbackHandler),
      )
    },
  }
}
