import type { Session } from "./subjects"

export const REALTIME_RECIPIENT_PROTOCOL = "authority-recipient-v2"

// The authority capability stays v2; r3 versions only the digest representation.
// 62^43 > 2^256: fixed-width base62 preserves every SHA-256 bit, including zeros.
const RECIPIENT_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

export type RealtimeRecipientId = string & {
  readonly __brand: "RealtimeRecipientId"
}

// AWS channel paths: 1–5 segments, 1–50 characters per segment, alphanumeric
// endpoints and internal hyphens. This contract is independent of our encoder.
// https://docs.aws.amazon.com/appsync/latest/eventapi/event-api-websocket-protocol.html#realtime-websocket-operations
export const isAppSyncChannelPath = (value: string): boolean =>
  /^(\/[A-Za-z0-9](?:[A-Za-z0-9-]{0,48}[A-Za-z0-9])?){1,5}$/.test(value)

export const isRealtimeRecipientId = (
  value: string,
): value is RealtimeRecipientId => /^r3-[A-Za-z0-9]{43}$/.test(value)

/** JWT expiry is in epoch seconds. This address is not an authorization decision. */
export const getRealtimeRecipientId = async (
  properties: Session,
  accessTokenExpiresAt?: number,
): Promise<RealtimeRecipientId | undefined> => {
  if (
    accessTokenExpiresAt === undefined ||
    !Number.isSafeInteger(accessTokenExpiresAt) ||
    accessTokenExpiresAt <= 0
  ) {
    return undefined
  }
  const authority = [
    properties.userId,
    [...new Set(properties.roles ?? [])].sort(),
    properties.orgUnitId ?? null,
    properties.orgUnitPath ?? null,
    accessTokenExpiresAt,
  ]
  const identity =
    "clientId" in properties
      ? ["service", properties.clientId, ...authority]
      : !properties.delegation
        ? ["human", properties.email, ...authority]
        : [
            "delegation",
            properties.email,
            properties.delegation?.id,
            properties.delegation?.generationId,
            properties.delegation?.name,
            properties.delegation?.expiresAt,
            properties.delegationRoleSelection === undefined
              ? null
              : [...new Set(properties.delegationRoleSelection)].sort(),
            ...authority,
          ]
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify([REALTIME_RECIPIENT_PROTOCOL, ...identity]),
    ),
  )
  let value = 0n
  for (const byte of new Uint8Array(digest))
    value = (value << 8n) | BigInt(byte)
  let encoded = ""
  while (value > 0n) {
    encoded = RECIPIENT_ALPHABET.charAt(Number(value % 62n)) + encoded
    value /= 62n
  }
  const recipient = `r3-${encoded.padStart(43, "0")}`
  return isRealtimeRecipientId(recipient) ? recipient : undefined
}
