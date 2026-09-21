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
  options: Schema.Struct({
    challenge: Schema.NonEmptyString,
    rp: Schema.Struct({
      id: Schema.NonEmptyString,
      name: Schema.NonEmptyString,
    }),
    user: Schema.Struct({
      id: Schema.NonEmptyString,
      name: Schema.NonEmptyString,
      displayName: Schema.String,
    }),
    pubKeyCredParams: Schema.mutable(
      Schema.Array(
        Schema.Struct({ type: Schema.Literal("public-key"), alg: Schema.Int }),
      ),
    ),
    timeout: Schema.optionalWith(Schema.Number, { exact: true }),
    attestation: Schema.optionalWith(
      Schema.Literal("none", "indirect", "direct", "enterprise"),
      { exact: true },
    ),
    excludeCredentials: Schema.optionalWith(
      Schema.mutable(
        Schema.Array(
          Schema.Struct({
            id: Schema.NonEmptyString,
            type: Schema.Literal("public-key"),
            transports: Schema.optionalWith(
              Schema.mutable(
                Schema.Array(
                  Schema.Literal(
                    "ble",
                    "cable",
                    "hybrid",
                    "internal",
                    "nfc",
                    "smart-card",
                    "usb",
                  ),
                ),
              ),
              { exact: true },
            ),
          }),
        ),
      ),
      { exact: true },
    ),
    authenticatorSelection: Schema.optionalWith(
      Schema.Struct({
        authenticatorAttachment: Schema.optionalWith(
          Schema.Literal("platform", "cross-platform"),
          { exact: true },
        ),
        residentKey: Schema.optionalWith(
          Schema.Literal("required", "preferred", "discouraged"),
          { exact: true },
        ),
        requireResidentKey: Schema.optionalWith(Schema.Boolean, {
          exact: true,
        }),
        userVerification: Schema.optionalWith(
          Schema.Literal("required", "preferred", "discouraged"),
          { exact: true },
        ),
      }),
      { exact: true },
    ),
    extensions: Schema.optionalWith(
      Schema.Struct({
        credProps: Schema.optionalWith(Schema.Boolean, { exact: true }),
      }),
      { exact: true },
    ),
  }),
})

export const RemovePasskey = Schema.Struct({
  id: Schema.NonEmptyString,
})
