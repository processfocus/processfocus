import { Schema } from "effect"

const IsoDate = Schema.String.pipe(
  Schema.filter((value) => Number.isFinite(Date.parse(value))),
)

export const PasskeyCredential = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.NullOr(Schema.String),
  createdAt: IsoDate,
  lastUsedAt: Schema.NullOr(IsoDate),
})

export type PasskeyCredential = typeof PasskeyCredential.Type

export const PasskeyList = Schema.Struct({
  organisation: Schema.Struct({ name: Schema.String }),
  account: Schema.Struct({
    userId: Schema.NonEmptyString,
    email: Schema.NonEmptyString,
  }),
  credentials: Schema.Array(PasskeyCredential),
})

export type PasskeyList = typeof PasskeyList.Type

export const RenamePasskey = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.Trim.pipe(Schema.minLength(1), Schema.maxLength(128)),
})

export const StartPasskeyEnrollment = Schema.Struct({
  name: Schema.Trim.pipe(Schema.minLength(1), Schema.maxLength(128)),
})

export const PasskeyEnrollmentOptions = Schema.Struct({
  challengeId: Schema.NonEmptyString,
  options: Schema.Unknown,
})
