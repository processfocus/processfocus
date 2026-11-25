import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Console, Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { CliError } from "../../errors"
import { credentialsExpired, readCredentials } from "../../utils/credentials"

const loginHint = 'Authentication required. Run "pforg auth login <base-url>".'
const PortFile = Schema.fromJsonString(Schema.Struct({ port: Schema.Number }))
const PasskeyList = Schema.Struct({
  credentials: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.NullOr(Schema.String),
      createdAt: Schema.String,
      lastUsedAt: Schema.NullOr(Schema.String),
    }),
  ),
})

const endpoint = (baseUrl: string): string => {
  const url = new URL(baseUrl)
  if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    let port = 4020
    try {
      const root =
        process.env["PF_RUNTIME_ROOT"] ??
        process.env["NX_WORKSPACE_ROOT"] ??
        process.cwd()
      port = Schema.decodeUnknownSync(PortFile)(
        readFileSync(join(root, ".auth-port.json"), "utf8"),
      ).port
    } catch {
      // Match the local authentication server's default when no port file exists.
    }
    return `http://localhost:${port}/oauth/passkeys`
  }
  return `${baseUrl.replace(/\/+$/, "")}/oauth/passkeys`
}

export const runPasskeysList: Effect.Effect<
  void,
  CliError,
  HttpClient.HttpClient
> = Effect.gen(function* () {
  const credentials = readCredentials()
  if (!credentials || credentialsExpired(credentials))
    return yield* new CliError({ message: loginHint })
  const url = yield* Effect.try({
    try: () => endpoint(credentials.baseUrl),
    catch: () => new CliError({ message: loginHint }),
  })
  const client = yield* HttpClient.HttpClient
  const response = yield* client
    .execute(
      HttpClientRequest.get(url).pipe(
        HttpClientRequest.bearerToken(credentials.accessToken),
      ),
    )
    .pipe(
      Effect.mapError(
        () =>
          new CliError({
            message:
              "Failed to call the passkey API. Check that the organisation runtime is reachable and try again.",
          }),
      ),
    )
  if (response.status === 401)
    return yield* new CliError({ message: loginHint })
  if (response.status === 403)
    return yield* new CliError({
      code: "PERMISSION_DENIED",
      message:
        "Passkey listing requires a human login and passkeys enabled in this organisation. Run pforg auth login <base-url> with your own account, or contact your administrator.",
    })
  if (response.status < 200 || response.status >= 300)
    return yield* new CliError({
      message: `Passkey API request failed with status ${response.status}. Check the organisation runtime and API version, then try again.`,
    })
  const result = yield* response.json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(PasskeyList)),
    Effect.mapError(
      () =>
        new CliError({
          code: "INVALID_RESPONSE",
          message:
            "Invalid passkey API response. Check the organisation API version.",
        }),
    ),
  )
  yield* Console.log(JSON.stringify(result.credentials))
}).pipe(Effect.scoped)
