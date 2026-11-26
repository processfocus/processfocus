import { Exit, Schema } from "effect"

// The prior signed access token binds a ceremony to its initiating identity.
const ReauthenticationState = Schema.Struct({
  state: Schema.NonEmptyString,
  accessToken: Schema.NonEmptyString,
})

export function readReauthenticationState(
  value: string | undefined,
): typeof ReauthenticationState.Type | null {
  const parsed = Schema.decodeUnknownExit(
    Schema.fromJsonString(ReauthenticationState),
  )(value)
  return Exit.isSuccess(parsed) ? parsed.value : null
}
