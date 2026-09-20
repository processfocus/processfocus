import { Effect, Either, Option, Schema } from "effect"
import { AuthenticationDatabase } from "./authentication-database.js"

const InviteOnlyConfigSchema = Schema.Struct({
  inviteOnly: Schema.optional(Schema.Boolean),
})

const readInviteOnly = (config: unknown): boolean => {
  const decoded = Schema.decodeUnknownEither(InviteOnlyConfigSchema)(config)
  return Either.isRight(decoded) ? (decoded.right.inviteOnly ?? true) : true
}

export const resolveInviteOnlyForProvider = (provider: string) =>
  Effect.gen(function* () {
    const db = yield* AuthenticationDatabase
    const providerRecord = yield* db.findOAuthProviderByName(provider)

    if (Option.isNone(providerRecord)) {
      yield* Effect.logWarning(
        "Auth provider missing invite-only config; defaulting to invite only",
      ).pipe(Effect.annotateLogs({ provider }))
      return true
    }

    return readInviteOnly(providerRecord.value.config)
  })
