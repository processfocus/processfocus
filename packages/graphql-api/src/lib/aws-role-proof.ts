import { createHash } from "node:crypto"
import { ByteSize, Clock, Data, DateTime, Effect, Option, Schema } from "effect"
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpIncomingMessage,
} from "effect/http"
import { AwsRoleBindingSchema } from "@pf/auth-config"
import { AwsRoleProofStore } from "@pf/graphql-db-operations"
import type { JWTPayload } from "./types"

export const AWS_PROOF_HEADER = "x-pf-aws-proof"
const STS_BODY = "Action=GetCallerIdentity&Version=2011-06-15"
const regions = new Set([
  "af-south-1",
  "ap-east-1",
  "ap-east-2",
  "ap-northeast-1",
  "ap-northeast-2",
  "ap-northeast-3",
  "ap-south-1",
  "ap-south-2",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-southeast-3",
  "ap-southeast-4",
  "ap-southeast-5",
  "ap-southeast-6",
  "ap-southeast-7",
  "ca-central-1",
  "ca-west-1",
  "eu-central-1",
  "eu-central-2",
  "eu-north-1",
  "eu-south-1",
  "eu-south-2",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "il-central-1",
  "me-central-1",
  "me-south-1",
  "mx-central-1",
  "sa-east-1",
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
])
const signedNames = [
  "content-type",
  "host",
  "x-amz-date",
  "x-amz-security-token",
  "x-pf-request-digest",
  "x-pf-request-id",
  "x-pf-target",
]
const Envelope = Schema.Tuple([
  Schema.Literal(1),
  Schema.String,
  Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
])

export class AwsProofRejected extends Data.TaggedError("AwsProofRejected")<{
  readonly message: string
}> {}
const rejected = () =>
  new AwsProofRejected({ message: "AWS request authentication rejected" })
const digest = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex")

/** Streaming limit applies before allocating the complete GraphQL body. */
const readBounded = async (
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
  signal: AbortSignal,
): Promise<Uint8Array> => {
  if (!stream) throw rejected()
  const reader = stream.getReader()
  const cancel = () => {
    void reader.cancel().catch(() => undefined)
  }
  signal.addEventListener("abort", cancel, { once: true })
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > limit) throw rejected()
      chunks.push(part.value)
    }
  } finally {
    // A cloned request is a tee: awaiting cancellation can wait for Yoga's reader.
    void reader.cancel().catch(() => undefined)
    signal.removeEventListener("abort", cancel)
    reader.releaseLock()
  }
  return Buffer.concat(chunks)
}

/** Exact v1 transcript: POST, supported path, then lowercase SHA256 of body bytes. */
const awsGraphqlDigest = (body: Uint8Array): string =>
  digest(`POST\n/graphql\n${digest(body)}`)

export const verifyAwsRoleProof = (
  request: Request,
  target: string,
): Effect.Effect<JWTPayload, AwsProofRejected> =>
  Effect.gen(function* () {
    const store = yield* Effect.serviceOption(AwsRoleProofStore)
    if (Option.isNone(store)) return yield* rejected()
    const proof = request.headers.get(AWS_PROOF_HEADER)
    const url = new URL(request.url)
    if (
      !proof ||
      proof.length > 16384 ||
      !/^[A-Za-z0-9_-]+$/.test(proof) ||
      request.method !== "POST" ||
      url.pathname !== "/graphql" ||
      url.search ||
      request.headers.has("authorization") ||
      request.headers.has("cookie") ||
      request.headers.get("content-type") !== "application/json" ||
      request.headers.has("content-encoding")
    )
      return yield* rejected()
    const [version, region, entries] = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Envelope),
      { onExcessProperty: "error" },
    )(Buffer.from(proof, "base64url").toString("utf8")).pipe(
      Effect.mapError(rejected),
    )
    if (
      version !== 1 ||
      !regions.has(region) ||
      entries.length !== signedNames.length + 1
    )
      return yield* rejected()
    const headers: Record<string, string> = {}
    for (const [name, value] of entries) {
      if (
        !(name === "authorization" || signedNames.includes(name)) ||
        Object.hasOwn(headers, name) ||
        !value ||
        value.length > 4096 ||
        /[^\x21-\x7e ]/.test(value) ||
        value.trim() !== value
      )
        return yield* rejected()
      headers[name] = value
    }
    const host = `sts.${region}.amazonaws.com`
    const timestamp = headers["x-amz-date"] ?? ""
    const requestId = headers["x-pf-request-id"] ?? ""
    const authorization = headers["authorization"] ?? ""
    const signature =
      /^AWS4-HMAC-SHA256 Credential=(ASIA[A-Z0-9]{16})\/(\d{8})\/([a-z0-9-]+)\/sts\/aws4_request, SignedHeaders=([^ ]+), Signature=([a-f0-9]{64})$/.exec(
        authorization,
      )
    if (
      !signature ||
      signature[2] !== timestamp.slice(0, 8) ||
      signature[3] !== region ||
      signature[4] !== signedNames.join(";") ||
      headers["host"] !== host ||
      headers["content-type"] !==
        "application/x-www-form-urlencoded; charset=utf-8" ||
      headers["x-pf-target"] !== target ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        requestId,
      ) ||
      !/^\d{8}T\d{6}Z$/.test(timestamp)
    )
      return yield* rejected()
    const signedAt = DateTime.make(
      `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}T${timestamp.slice(9, 11)}:${timestamp.slice(11, 13)}:${timestamp.slice(13, 15)}Z`,
    )
    if (Option.isNone(signedAt)) return yield* rejected()
    const signedMillis = DateTime.toEpochMillis(signedAt.value)
    const fresh = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      if (now < signedMillis - 5000 || now >= signedMillis + 60000)
        return yield* rejected()
      return now
    })
    yield* fresh
    const body = yield* Effect.tryPromise({
      try: (signal) => readBounded(request.clone().body, 1024 * 1024, signal),
      catch: rejected,
    })
    if (headers["x-pf-request-digest"] !== awsGraphqlDigest(body))
      return yield* rejected()
    const http = yield* Effect.serviceOption(HttpClient.HttpClient)
    if (Option.isNone(http)) return yield* rejected()
    const response = yield* http.value
      .execute(
        HttpClientRequest.post(`https://${host}/`).pipe(
          HttpClientRequest.bodyText(STS_BODY, headers["content-type"]),
          HttpClientRequest.setHeaders(headers),
        ),
      )
      .pipe(
        Effect.provideService(FetchHttpClient.RequestInit, {
          redirect: "error",
        }),
        Effect.mapError(rejected),
      )
    if (response.status !== 200) return yield* rejected()
    // STS Query responses are XML. Only the three simple identity fields are accepted;
    // entities, duplicate fields and nested content cannot become identity evidence.
    const xml = yield* response.text.pipe(Effect.mapError(rejected))
    if (
      xml.length > 8192 ||
      /<!|&/.test(xml) ||
      !/^(?:<\?xml[^?]*\?>\s*)?<GetCallerIdentityResponse xmlns="https:\/\/sts.amazonaws.com\/doc\/2011-06-15\/">\s*<GetCallerIdentityResult>\s*(?:<(?:Arn|UserId|Account)>[^<>]+<\/(?:Arn|UserId|Account)>\s*){3}<\/GetCallerIdentityResult>\s*(?:<ResponseMetadata>\s*<RequestId>[A-Za-z0-9-]+<\/RequestId>\s*<\/ResponseMetadata>\s*)?<\/GetCallerIdentityResponse>\s*$/.test(
        xml,
      )
    )
      return yield* rejected()
    const field = (name: string): string | undefined => {
      const matches = [
        ...xml.matchAll(new RegExp(`<${name}>([^<>]+)</${name}>`, "g")),
      ]
      return matches.length === 1 ? matches[0]?.[1] : undefined
    }
    const accountId = field("Account")
    const userId = field("UserId")
    const arn = field("Arn")
    const identity = /^(AROA[A-Z0-9]{17}):([A-Za-z0-9_+=,.@-]{2,64})$/.exec(
      userId ?? "",
    )
    const arnIdentity =
      /^arn:aws:sts::(\d{12}):assumed-role\/([A-Za-z0-9_+=,.@-]{1,64})\/([A-Za-z0-9_+=,.@-]{2,64})$/.exec(
        arn ?? "",
      )
    const roleId = identity?.[1]
    const roleName = arnIdentity?.[2]
    if (
      !accountId ||
      !/^\d{12}$/.test(accountId) ||
      !roleId ||
      !roleName ||
      !arnIdentity ||
      arnIdentity[1] !== accountId ||
      arnIdentity[3] !== identity?.[2]
    )
      return yield* rejected()
    const candidates: { clientId: string; bindingId: string }[] = []
    for (const client of yield* store.value.clients.pipe(
      Effect.mapError(rejected),
    )) {
      if (client.bindings == null) continue
      const bindings = yield* Schema.decodeUnknownEffect(
        Schema.Array(AwsRoleBindingSchema),
      )(client.bindings).pipe(Effect.mapError(rejected))
      for (const binding of bindings) {
        if (
          binding.targetIssuer === target &&
          binding.accountId === accountId &&
          (binding.roleId === undefined
            ? binding.roleName === roleName
            : binding.roleId === roleId) &&
          binding.serviceAccountId === client.clientId
        )
          candidates.push({ clientId: client.clientId, bindingId: binding.id })
      }
    }
    const binding = candidates[0]
    if (candidates.length !== 1 || !binding) return yield* rejected()
    const now = yield* fresh
    // Keep a ten-second safety margin beyond the complete signed acceptance window.
    yield* store.value
      .cleanup(DateTime.makeUnsafe(now))
      .pipe(Effect.mapError(rejected))
    const key = `aws-role-proof:${digest(JSON.stringify([target, accountId, roleId, requestId]))}`
    if (
      !(yield* store.value
        .consume(key, DateTime.makeUnsafe(signedMillis + 70000))
        .pipe(Effect.mapError(rejected)))
    )
      return yield* rejected()
    return {
      mode: "access",
      type: "user",
      aud: "graphql-api",
      iss: target,
      sub: binding.clientId,
      exp: Math.floor((signedMillis + 60000) / 1000),
      properties: {
        userId: `aws:${binding.clientId}`,
        clientId: binding.clientId,
        awsRole: {
          provider: "aws",
          accountId,
          roleId,
          bindingId: binding.bindingId,
          requestId,
          expiresAt: signedMillis + 60000,
        },
      },
    } satisfies JWTPayload
  }).pipe(
    Effect.provideService(
      HttpIncomingMessage.MaxBodySize,
      ByteSize.bytes(8192),
    ),
    Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
    Effect.timeout("5 seconds"),
    Effect.mapError(rejected),
  )
