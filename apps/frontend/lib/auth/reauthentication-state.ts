import { Either, Schema } from "effect"

// The prior signed access token binds a ceremony to its initiating identity.
const ReauthenticationState = Schema.Struct({
  state: Schema.NonEmptyString,
  accessToken: Schema.NonEmptyString,
})

export function readReauthenticationState(
  value: string | undefined,
): typeof ReauthenticationState.Type | null {
  const parsed = Schema.decodeUnknownEither(
    Schema.parseJson(ReauthenticationState),
  )(value)
  return Either.isRight(parsed) ? parsed.right : null
}
