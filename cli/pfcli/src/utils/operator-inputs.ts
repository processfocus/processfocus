import { Effect } from "effect"
import { CliError } from "../errors"

export interface DatabaseOptions {
  readonly databasePath?: string | undefined
}

export interface FrontendJwtOptions extends DatabaseOptions {
  readonly issuerUrl?: string | undefined
}

/** Validate explicit command inputs without echoing potentially sensitive input. */
export const validateUrlOption = (
  value: string,
  option: string,
  originOnly = false,
): Effect.Effect<string, CliError> =>
  Effect.gen(function* () {
    const url = URL.parse(value)
    if (
      !url ||
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (originOnly && url.pathname !== "/")
    ) {
      return yield* new CliError({
        message: `${option} must be an absolute HTTP(S) ${originOnly ? "origin (no path), for example https://app.example.com" : "URL"} without credentials, a query, or a fragment.`,
      })
    }
    return originOnly ? url.origin : value
  })
