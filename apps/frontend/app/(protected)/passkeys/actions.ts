"use server"

import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
} from "@effect/platform"
import { Effect, Either, Schema } from "effect"
import { getIssuerUrl } from "@/lib/auth/issuer"
import {
  PasskeyEnrollmentOptions,
  PasskeyList,
  RemovePasskey,
  RenamePasskey,
  StartPasskeyEnrollment,
} from "@/lib/auth/passkeys"
import { getSessionWithToken } from "@/lib/auth/session"

type Failure = { kind: "error" | "denied"; message: string }
type Duplicate = { kind: "already_registered"; message: string }
type Listed = { kind: "success" } & typeof PasskeyList.Type
type Enrollment = { kind: "options" } & typeof PasskeyEnrollmentOptions.Type

const sessionDenied = {
  kind: "denied",
  message: "Your session is unavailable or has expired. Log in again.",
} as const
const managementDenied = {
  kind: "denied",
  message:
    "Passkey management is not available for this account in this organisation.",
} as const
const nameError = "Enter a name for this Passkey."

const passkeySession = getSessionWithToken.pipe(
  Effect.catchTags({
    NoAccessTokenError: () => Effect.succeed(null),
    JWTVerificationError: () => Effect.succeed(null),
  }),
)

function requestPasskeys<
  A,
  I,
  K extends "success" | "options",
  Extra extends Duplicate = never,
>({
  method,
  body,
  schema,
  kind,
  message,
  statuses = {},
}: {
  method: "GET" | "PATCH" | "POST" | "DELETE"
  body?: unknown
  schema: Schema.Schema<A, I>
  kind: K
  message: string
  statuses?: Readonly<Record<number, Failure | NoInfer<Extra>>>
}): Promise<({ kind: K } & A) | Failure | Extra> {
  return Effect.gen(function* () {
    const session = yield* passkeySession
    if (session === null) return sessionDenied
    let request = HttpClientRequest.make(method)(
      `${getIssuerUrl()}/oauth/passkeys`,
    ).pipe(HttpClientRequest.bearerToken(session.accessToken))
    if (body !== undefined)
      request = yield* HttpClientRequest.bodyJson(request, body)
    const response = yield* (yield* HttpClient.HttpClient).execute(request)
    if (response.status === 401) return sessionDenied
    if (response.status === 403) return managementDenied
    if (response.status < 200 || response.status >= 300)
      return statuses[response.status] ?? { kind: "error" as const, message }
    const data = yield* response.json.pipe(
      Effect.flatMap(Schema.decodeUnknown(schema)),
    )
    return { kind, ...data }
  }).pipe(
    Effect.catchAll(() => Effect.succeed({ kind: "error" as const, message })),
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.RequestInit, {
      cache: "no-store",
      redirect: "error",
    }),
    Effect.runPromise,
  )
}

export async function listPasskeys(): Promise<Listed | Failure> {
  return requestPasskeys<
    typeof PasskeyList.Type,
    typeof PasskeyList.Encoded,
    "success"
  >({
    method: "GET",
    schema: PasskeyList,
    kind: "success",
    message: "Unable to load Passkeys.",
  })
}

export async function renamePasskey(input: unknown): Promise<Listed | Failure> {
  const parsed = Schema.decodeUnknownEither(RenamePasskey)(input)
  if (Either.isLeft(parsed)) return { kind: "error", message: nameError }
  return requestPasskeys<
    typeof PasskeyList.Type,
    typeof PasskeyList.Encoded,
    "success"
  >({
    method: "PATCH",
    body: parsed.right,
    schema: PasskeyList,
    kind: "success",
    message: "Unable to rename this Passkey.",
    statuses: { 400: { kind: "error", message: nameError } },
  })
}

export async function startPasskeyEnrollment(
  input: unknown,
): Promise<Enrollment | Failure> {
  const parsed = Schema.decodeUnknownEither(StartPasskeyEnrollment)(input)
  if (Either.isLeft(parsed)) return { kind: "error", message: nameError }
  return requestPasskeys<
    typeof PasskeyEnrollmentOptions.Type,
    typeof PasskeyEnrollmentOptions.Encoded,
    "options"
  >({
    method: "POST",
    body: parsed.right,
    schema: PasskeyEnrollmentOptions,
    kind: "options",
    message: "Unable to start Passkey registration.",
  })
}

export async function verifyPasskeyEnrollment(
  input: unknown,
): Promise<Listed | Failure | Duplicate> {
  return requestPasskeys<
    typeof PasskeyList.Type,
    typeof PasskeyList.Encoded,
    "success",
    Duplicate
  >({
    method: "POST",
    body: input,
    schema: PasskeyList,
    kind: "success",
    message: "Unable to add this Passkey.",
    statuses: {
      409: {
        kind: "already_registered",
        message:
          "This Passkey is already registered. Try a different authenticator.",
      },
      400: {
        kind: "error",
        message:
          "Passkey registration could not be verified. You can try again.",
      },
    },
  })
}

export async function removePasskey(input: unknown): Promise<Listed | Failure> {
  const parsed = Schema.decodeUnknownEither(RemovePasskey)(input)
  if (Either.isLeft(parsed))
    return { kind: "error", message: "Unable to remove this Passkey." }
  return requestPasskeys<
    typeof PasskeyList.Type,
    typeof PasskeyList.Encoded,
    "success"
  >({
    method: "DELETE",
    body: parsed.right,
    schema: PasskeyList,
    kind: "success",
    message: "Unable to remove this Passkey.",
    statuses: {
      409: {
        kind: "error",
        message: "Add a replacement Passkey before removing this one.",
      },
    },
  })
}
