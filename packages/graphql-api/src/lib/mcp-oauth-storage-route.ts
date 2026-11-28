import { createHmac, timingSafeEqual } from "node:crypto"
import { DateTime, Effect, Option, Schema } from "effect"
import { McpOAuthOperation, McpOAuthRecords } from "@pf/graphql-db-operations"

const path = "/internal/mcp-oauth"
const decode = Schema.decodeUnknownOption(McpOAuthOperation)
const headers = { "Cache-Control": "no-store" }

export const makeMcpOAuthStorageRoute = (secret: string | undefined) =>
  Effect.gen(function* () {
    const store = yield* McpOAuthRecords
    const expected = secret
      ? createHmac("sha256", secret).update(path).digest("base64url")
      : undefined
    return (request: Request) => {
      if (new URL(request.url).pathname !== path) return undefined
      return Effect.gen(function* () {
        const authorization = request.headers.get("authorization")
        const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization ?? "")
        const token = match?.[1]
        if (
          !expected ||
          !token ||
          !timingSafeEqual(Buffer.from(token), Buffer.from(expected))
        )
          return new Response(null, { status: 401, headers })
        if (request.method !== "POST")
          return new Response(null, { status: 405, headers })
        const operation = decode(
          yield* Effect.promise(() => request.json().catch(() => undefined)),
        )
        if (Option.isNone(operation))
          return new Response(null, { status: 400, headers })

        return yield* store.operate(operation.value, yield* DateTime.now).pipe(
          Effect.withTracerEnabled(false),
          Effect.map((result) => Response.json(result, { headers })),
          // SQL errors can contain bound OAuth credential material.
          Effect.catchCause(() =>
            Effect.logError("MCP OAuth storage failed").pipe(
              Effect.as(new Response(null, { status: 503, headers })),
            ),
          ),
        )
      })
    }
  })
