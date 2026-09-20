import { Console, Effect } from "effect"
import { AuthError } from "../../errors"
import { credentialsExpired, readCredentials } from "../../utils/credentials"

const LOGIN_HINT = 'Authentication required. Run "pforg auth login <base-url>".'

export const runAuthStatus = Effect.gen(function* () {
  const credentials = readCredentials()
  if (!credentials || credentialsExpired(credentials)) {
    return yield* new AuthError({ message: LOGIN_HINT })
  }

  yield* Console.log(`Base URL: ${credentials.baseUrl}`)
  yield* Console.log(`Expires at: ${credentials.expiresAt}`)
})
