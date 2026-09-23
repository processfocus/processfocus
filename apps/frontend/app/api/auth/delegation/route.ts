import { Schema } from "effect"
import { subjects } from "@pf/auth-session"
import { getAuthClient } from "@/lib/auth/client"
import { getFrontendAuthClientConfig } from "@/lib/auth/issuer"
import { decodeJwtPayload } from "@/lib/auth/jwt"
import { setSessionCookies } from "@/lib/auth/session"
import { admitsNewSession } from "@/lib/auth/session-admission"

const Tokens = Schema.Struct({
  access_token: Schema.NonEmptyString,
  refresh_token: Schema.NonEmptyString,
  expires_in: Schema.Number.pipe(Schema.positive(), Schema.finite()),
  refresh_expires_in: Schema.Number.pipe(Schema.positive(), Schema.finite()),
})
const respond = (success: boolean, status: number) =>
  Response.json(
    { success },
    {
      status,
      headers: { "Cache-Control": "no-store", Pragma: "no-cache" },
    },
  )

let windowStart = 0
let attempts = 0

export async function POST(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url)
    if (
      url.search ||
      request.headers.get("origin") !== url.origin ||
      request.headers.get("content-type")?.split(";")[0] !==
        "application/json" ||
      (url.protocol !== "https:" &&
        !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
      return respond(false, 403)

    const now = Date.now()
    if (now >= windowStart + 60_000) {
      windowStart = now
      attempts = 0
    }
    if (++attempts > 30) return respond(false, 429)

    // Bound actual streamed bytes, including requests without Content-Length.
    const reader = request.body?.getReader()
    if (!reader) return respond(false, 400)
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > 1024) {
          await reader.cancel()
          return respond(false, 413)
        }
        chunks.push(chunk.value)
      }
    } finally {
      reader.releaseLock()
    }
    const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
    if (
      typeof input !== "object" ||
      input === null ||
      Object.keys(input).length !== 1 ||
      !("secret" in input) ||
      typeof input.secret !== "string" ||
      !/^pfds_[A-Za-z0-9_-]{43}$/.test(input.secret)
    )
      return respond(false, 400)

    const { issuer, jwt } = getFrontendAuthClientConfig()
    const issuerUrl = new URL(issuer)
    if (
      issuerUrl.protocol !== "https:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(issuerUrl.hostname)
    )
      return respond(false, 401)
    const response = await fetch(`${issuer}/oauth/delegation`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ secret: input.secret }),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) return respond(false, response.status === 429 ? 429 : 401)
    const tokens = Schema.decodeUnknownSync(Tokens)(await response.json())
    const verified = await getAuthClient().verify(
      subjects,
      tokens.access_token,
      undefined,
    )
    if (verified.err || verified.subject.type !== "providerUser")
      return respond(false, 401)
    const session = verified.subject.properties
    const expiry = decodeJwtPayload(tokens.access_token)?.exp
    if (
      !session.delegation ||
      session.humanAuthentication !== undefined ||
      !expiry ||
      expiry * 1000 > session.delegation.expiresAt
    )
      return respond(false, 401)
    const remaining = Math.floor(
      (session.delegation.expiresAt - Date.now()) / 1000,
    )
    if (remaining <= 0) return respond(false, 401)
    if (!(await admitsNewSession()))
      return Response.json(
        { success: false, error: "environment_unavailable" },
        {
          status: 503,
          headers: { "Cache-Control": "no-store", Pragma: "no-cache" },
        },
      )
    await setSessionCookies({
      access: tokens.access_token,
      refresh: tokens.refresh_token,
      expiresIn: Math.min(tokens.expires_in, remaining),
      refreshExpiresIn: Math.min(tokens.refresh_expires_in, remaining),
    })
    return respond(true, 200)
  } catch {
    // Never forward or report credential-bearing request/upstream error objects.
    return respond(false, 401)
  }
}
