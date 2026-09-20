"use server"

import { Effect, Either, Schema } from "effect"
import { getIssuerUrl } from "@/lib/auth/issuer"
import {
  PasskeyEnrollmentOptions,
  PasskeyList,
  RenamePasskey,
  StartPasskeyEnrollment,
} from "@/lib/auth/passkeys"
import { getSessionWithToken } from "@/lib/auth/session"

const sessionDenied = {
  kind: "denied",
  message: "Your session is unavailable or has expired. Log in again.",
} as const

const managementDenied = {
  kind: "denied",
  message:
    "Passkey management is not available for this account in this organisation.",
} as const

const passkeySession = getSessionWithToken.pipe(
  Effect.catchTags({
    NoAccessTokenError: () => Effect.succeed(null),
    JWTVerificationError: () => Effect.succeed(null),
  }),
)

export async function listPasskeys(): Promise<
  | ({ kind: "success" } & typeof PasskeyList.Type)
  | { kind: "error"; message: string }
  | { kind: "denied"; message: string }
> {
  try {
    const session = await Effect.runPromise(passkeySession)
    if (session === null) return sessionDenied
    const response = await fetch(`${getIssuerUrl()}/passkeys`, {
      headers: { Authorization: `Bearer ${session.accessToken}` },
      cache: "no-store",
      redirect: "error",
    })
    if (response.status === 401) return sessionDenied
    if (!response.ok)
      return {
        kind: response.status === 403 ? "denied" : "error",
        message:
          response.status === 403
            ? managementDenied.message
            : "Unable to load Passkeys.",
      } as const
    const data = Schema.decodeUnknownSync(PasskeyList)(await response.json())
    return { kind: "success", ...data } as const
  } catch {
    return {
      kind: "error",
      message: "Unable to load Passkeys.",
    } as const
  }
}

export async function renamePasskey(
  input: unknown,
): Promise<
  | ({ kind: "success" } & typeof PasskeyList.Type)
  | { kind: "error"; message: string }
  | { kind: "denied"; message: string }
> {
  const parsed = Schema.decodeUnknownEither(RenamePasskey)(input)
  if (Either.isLeft(parsed)) {
    return {
      kind: "error",
      message: "Enter a name for this Passkey.",
    } as const
  }
  try {
    const session = await Effect.runPromise(passkeySession)
    if (session === null) return sessionDenied
    const response = await fetch(`${getIssuerUrl()}/passkeys`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(parsed.right),
      cache: "no-store",
      redirect: "error",
    })
    if (response.status === 401) return sessionDenied
    if (!response.ok)
      return {
        kind: response.status === 403 ? "denied" : "error",
        message:
          response.status === 400
            ? "Enter a name for this Passkey."
            : response.status === 403
              ? managementDenied.message
              : "Unable to rename this Passkey.",
      } as const
    const data = Schema.decodeUnknownSync(PasskeyList)(await response.json())
    return { kind: "success", ...data } as const
  } catch {
    return {
      kind: "error",
      message: "Unable to rename this Passkey.",
    } as const
  }
}

export async function startPasskeyEnrollment(
  input: unknown,
): Promise<
  | ({ kind: "options" } & typeof PasskeyEnrollmentOptions.Type)
  | { kind: "error"; message: string }
  | { kind: "denied"; message: string }
> {
  const parsed = Schema.decodeUnknownEither(StartPasskeyEnrollment)(input)
  if (Either.isLeft(parsed)) {
    return {
      kind: "error",
      message: "Enter a name for this Passkey.",
    } as const
  }
  try {
    const session = await Effect.runPromise(passkeySession)
    if (session === null) return sessionDenied
    const response = await fetch(`${getIssuerUrl()}/passkeys`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(parsed.right),
      cache: "no-store",
      redirect: "error",
    })
    if (response.status === 401) return sessionDenied
    if (!response.ok)
      return {
        kind: response.status === 403 ? "denied" : "error",
        message:
          response.status === 403
            ? managementDenied.message
            : "Unable to start Passkey registration.",
      } as const
    const data = Schema.decodeUnknownSync(PasskeyEnrollmentOptions)(
      await response.json(),
    )
    return { kind: "options", ...data } as const
  } catch {
    return {
      kind: "error",
      message: "Unable to start Passkey registration.",
    } as const
  }
}

export async function verifyPasskeyEnrollment(
  input: unknown,
): Promise<
  | ({ kind: "success" } & typeof PasskeyList.Type)
  | { kind: "error"; message: string }
  | { kind: "denied"; message: string }
  | { kind: "already_registered"; message: string }
> {
  try {
    const session = await Effect.runPromise(passkeySession)
    if (session === null) return sessionDenied
    const response = await fetch(`${getIssuerUrl()}/passkeys`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
      cache: "no-store",
      redirect: "error",
    })
    if (response.status === 401) return sessionDenied
    if (response.status === 409)
      return {
        kind: "already_registered",
        message:
          "This Passkey is already registered. Try a different authenticator.",
      } as const
    if (!response.ok)
      return {
        kind: response.status === 403 ? "denied" : "error",
        message:
          response.status === 403
            ? managementDenied.message
            : response.status === 400
              ? "Passkey registration could not be verified. You can try again."
              : "Unable to add this Passkey.",
      } as const
    const data = Schema.decodeUnknownSync(PasskeyList)(await response.json())
    return { kind: "success", ...data } as const
  } catch {
    return {
      kind: "error",
      message: "Unable to add this Passkey.",
    } as const
  }
}
