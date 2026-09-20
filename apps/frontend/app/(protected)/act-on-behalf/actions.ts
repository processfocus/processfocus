"use server"

import { Effect, Either, Schema } from "effect"
import {
  CreateDelegation,
  DelegationList,
  DelegationMetadata,
  IssuedDelegation,
  UpdateDelegation,
} from "@/lib/auth/delegations"
import { getIssuerUrl } from "@/lib/auth/issuer"
import { getSessionWithToken } from "@/lib/auth/session"

type Result<T> =
  | { kind: "success"; data: T }
  | { kind: "error"; message: string }
  | { kind: "verification_required" }
  | typeof sessionDenied

const sessionDenied = {
  kind: "denied",
  message: "Your session is unavailable or has expired. Log in again.",
} as const

const delegationSession = getSessionWithToken.pipe(
  Effect.catchTags({
    NoAccessTokenError: () => Effect.succeed(null),
    JWTVerificationError: () => Effect.succeed(null),
  }),
)

function parseErrorCode(body: unknown): string | null {
  return typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof body.error === "string"
    ? body.error
    : null
}

export async function listDelegations(
  ownerUserId?: string,
): Promise<
  | ({ kind: "success" } & typeof DelegationList.Type)
  | { kind: "error"; message: string }
  | { kind: "denied"; message: string }
> {
  try {
    const session = await Effect.runPromise(delegationSession)
    if (session === null) return sessionDenied
    const url = new URL(`${getIssuerUrl()}/delegations`)
    if (ownerUserId !== undefined)
      url.searchParams.set(
        "ownerUserId",
        Schema.decodeUnknownSync(Schema.NonEmptyString)(ownerUserId),
      )
    const response = await fetch(url.toString(), {
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
            ? "You are not permitted to inspect this owner's Delegation Tokens."
            : "Unable to load delegated access.",
      } as const
    const data = Schema.decodeUnknownSync(DelegationList)(await response.json())
    return { kind: "success", ...data } as const
  } catch {
    return {
      kind: "error",
      message: "Unable to load delegated access.",
    } as const
  }
}

export async function createDelegation(
  input: unknown,
  ownerUserId?: string,
): Promise<Result<typeof IssuedDelegation.Type>> {
  const parsed = Schema.decodeUnknownEither(CreateDelegation)(input)
  if (Either.isLeft(parsed)) {
    return {
      kind: "error",
      message: "Enter a name and select 1, 7, or 14 days.",
    } as const
  }
  try {
    const session = await Effect.runPromise(delegationSession)
    if (session === null) return sessionDenied
    const url = new URL(`${getIssuerUrl()}/delegations`)
    if (ownerUserId !== undefined)
      url.searchParams.set(
        "ownerUserId",
        Schema.decodeUnknownSync(Schema.NonEmptyString)(ownerUserId),
      )
    const response = await fetch(url.toString(), {
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
    if (!response.ok) {
      const code = parseErrorCode(await response.json())
      if (response.status === 403 && code === "verification_required")
        return { kind: "verification_required" }
      const message =
        code === "unsupported_authentication"
          ? "Your sign-in method cannot verify token creation. Ask your administrator for a supported sign-in method or token issuance permission."
          : code === "submission_replayed"
            ? "This request was already completed. Reload your token list; its secret cannot be shown again."
            : response.status === 409
              ? "An active token already uses this name. Choose another name."
              : response.status === 403
                ? "Token creation is not permitted by your organisation. Ask your administrator to check your access."
                : "Unable to create the secret. Check your token list before retrying."
      return { kind: "error", message } as const
    }
    // Decode only the allowed response fields; never report the payload on failure.
    const data = Schema.decodeUnknownSync(IssuedDelegation)(
      await response.json(),
    )
    return { kind: "success", data } as const
  } catch {
    return {
      kind: "error",
      message:
        "Unable to create the secret. Check your token list before retrying.",
    } as const
  }
}

export async function updateDelegation(
  input: unknown,
  ownerUserId?: string,
): Promise<
  | {
      kind: "success"
      data: typeof DelegationMetadata.Type | typeof IssuedDelegation.Type
    }
  | { kind: "error"; message: string; reloadRequired: boolean }
  | { kind: "verification_required" }
  | typeof sessionDenied
> {
  const parsed = Schema.decodeUnknownEither(UpdateDelegation)(input)
  if (Either.isLeft(parsed)) {
    return {
      kind: "error",
      message: "Enter a name and select 1, 7, or 14 days for a new secret.",
      reloadRequired: false,
    }
  }
  try {
    const session = await Effect.runPromise(delegationSession)
    if (session === null) return sessionDenied
    const url = new URL(`${getIssuerUrl()}/delegations`)
    if (ownerUserId !== undefined)
      url.searchParams.set(
        "ownerUserId",
        Schema.decodeUnknownSync(Schema.NonEmptyString)(ownerUserId),
      )
    const response = await fetch(url.toString(), {
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
    if (!response.ok) {
      const code = parseErrorCode(await response.json())
      if (response.status === 403 && code === "verification_required")
        return { kind: "verification_required" }
      if (response.status === 403 && code === "unsupported_authentication")
        return {
          kind: "error",
          message:
            "Your sign-in method cannot verify token replacement. Ask your administrator for a supported sign-in method or token issuance permission.",
          reloadRequired: false,
        }
      if (response.status === 409 && code === "name_conflict")
        return {
          kind: "error",
          message:
            "An active token already uses this name. Choose another name.",
          reloadRequired: false,
        }
      if (response.status === 409 && code === "stale_delegation")
        return {
          kind: "error",
          message:
            "This token changed elsewhere. Reload the token list before trying again.",
          reloadRequired: true,
        }
      if (response.status === 403 && code === "issuance_denied")
        return {
          kind: "error",
          message:
            "Token replacement is not permitted by your organisation. Ask your administrator to check your access.",
          reloadRequired: false,
        }
      if (response.status === 403)
        return {
          kind: "error",
          message:
            "This operation is no longer permitted. Reload the token list to see available actions.",
          reloadRequired: true,
        }
      if (response.status === 404)
        return {
          kind: "error",
          message: "This token is no longer available. Reload the token list.",
          reloadRequired: true,
        }
      return {
        kind: "error",
        message:
          "Unable to update the token. Reload the token list before retrying.",
        reloadRequired: true,
      }
    }
    const body: unknown = await response.json()
    const data =
      parsed.right.operation === "replace"
        ? Schema.decodeUnknownSync(IssuedDelegation)(body)
        : Schema.decodeUnknownSync(DelegationMetadata)(body)
    return { kind: "success", data }
  } catch {
    return {
      kind: "error",
      message:
        "Unable to update the token. Reload the token list before retrying.",
      reloadRequired: true,
    }
  }
}
