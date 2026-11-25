import { Schema } from "effect"

const IsoDate = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter((value) => Number.isFinite(Date.parse(value))),
  ),
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
  name: Schema.Trim.pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(128)),
  ),
})

export const StartPasskeyEnrollment = Schema.Struct({
  name: Schema.Trim.pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(128)),
  ),
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
    timeout: Schema.optionalKey(Schema.Number),
    attestation: Schema.optionalKey(
      Schema.Literals(["none", "indirect", "direct", "enterprise"]),
    ),
    excludeCredentials: Schema.optionalKey(
      Schema.mutable(
        Schema.Array(
          Schema.Struct({
            id: Schema.NonEmptyString,
            type: Schema.Literal("public-key"),
            transports: Schema.optionalKey(
              Schema.mutable(
                Schema.Array(
                  Schema.Literals([
                    "ble",
                    "cable",
                    "hybrid",
                    "internal",
                    "nfc",
                    "smart-card",
                    "usb",
                  ]),
                ),
              ),
            ),
          }),
        ),
      ),
    ),
    authenticatorSelection: Schema.optionalKey(
      Schema.Struct({
        authenticatorAttachment: Schema.optionalKey(
          Schema.Literals(["platform", "cross-platform"]),
        ),
        residentKey: Schema.optionalKey(
          Schema.Literals(["required", "preferred", "discouraged"]),
        ),
        requireResidentKey: Schema.optionalKey(Schema.Boolean),
        userVerification: Schema.optionalKey(
          Schema.Literals(["required", "preferred", "discouraged"]),
        ),
      }),
    ),
    extensions: Schema.optionalKey(
      Schema.Struct({
        credProps: Schema.optionalKey(Schema.Boolean),
      }),
    ),
  }),
})

export const RemovePasskey = Schema.Struct({
  id: Schema.NonEmptyString,
})
