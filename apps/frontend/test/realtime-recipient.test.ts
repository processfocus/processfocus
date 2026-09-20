import type { ProviderUserSession } from "@pf/auth-session"
import { getRealtimeRecipientId } from "@pf/auth-session/realtime-recipient"
import { toClientSession } from "../lib/auth/client-session"
import { matchesRealtimeSessionToken } from "../lib/auth/realtime-session-token"
import { buildChannelPath } from "../lib/collections/replication-factory"
import { expect, test } from "bun:test"

const human: ProviderUserSession = {
  userId: "owner",
  email: "owner@example.test",
  roles: ["/Worker"],
  orgUnitId: "org",
  orgUnitPath: "/",
}
const delegation = {
  id: "agent",
  generationId: "one",
  name: "Agent",
  expiresAt: 2_000_000_000_000,
}
const channel = "/rxdb/collection/todo"

test("frontend addresses the exact human, actor, generation and token authority", async () => {
  const sessions = [
    human,
    { ...human, delegation },
    { ...human, delegation: { ...delegation, id: "other" } },
    { ...human, delegation: { ...delegation, generationId: "two" } },
    { ...human, delegation, roles: ["/Other"] },
    { userId: human.userId, clientId: "service" },
    { ...human, roles: ["/Other"] },
  ]
  const paths = await Promise.all(
    sessions.map(async (session) =>
      buildChannelPath(
        channel,
        await getRealtimeRecipientId(session, 1_999_999_999),
      ),
    ),
  )
  expect(paths[0]).toMatch(
    /^\/rxdb\/collection\/todo\/user\/r3-[A-Za-z0-9]{43}$/,
  )
  expect(new Set(paths).size).toBe(sessions.length)
  expect(
    buildChannelPath(
      channel,
      await getRealtimeRecipientId({ ...human, delegation }, 2_000_000_000),
    ),
  ).not.toBe(paths[1])
  expect(await getRealtimeRecipientId(human, 2_000_000_000)).not.toBe(
    await getRealtimeRecipientId(human, 1_999_999_999),
  )
})

test("missing expiry for every actor fails closed without an owner/base channel fallback", async () => {
  for (const session of [
    human,
    { ...human, delegation },
    { userId: "owner", clientId: "service" },
  ]) {
    for (const expiry of [undefined, NaN, 0]) {
      const recipient = await getRealtimeRecipientId(session, expiry)
      expect(recipient).toBeUndefined()
      expect(() => buildChannelPath(channel, recipient)).toThrow()
    }
  }
  expect(() => buildChannelPath(channel, "owner/*")).toThrow()
  expect(() => buildChannelPath(channel, human.userId)).toThrow()
  expect(() =>
    buildChannelPath(channel, "r-OpkHcIOgkPMYtdi_u8LptCz2QHPbnJo-ROkn29r_4kQ"),
  ).toThrow()
  expect(() => buildChannelPath(channel, `r-${"A".repeat(43)}`)).toThrow()
})

test("initial cookie must match the server session, generation, roles and exact JWT expiry", () => {
  const expiresAt = Math.floor(Date.now() / 1000) + 60
  const session = { ...human, delegation }
  const token = `header.${Buffer.from(JSON.stringify({ exp: expiresAt, properties: session })).toString("base64url")}.signature`
  expect(matchesRealtimeSessionToken(token, session, expiresAt)).toBe(true)
  expect(matchesRealtimeSessionToken(token, human, expiresAt)).toBe(false)
  expect(matchesRealtimeSessionToken(token, session, expiresAt + 1)).toBe(false)
  expect(
    matchesRealtimeSessionToken(token, { ...session, roles: [] }, expiresAt),
  ).toBe(false)
  expect(
    matchesRealtimeSessionToken(
      token,
      {
        ...session,
        delegation: { ...delegation, generationId: "two" },
      },
      expiresAt,
    ),
  ).toBe(false)
  expect(matchesRealtimeSessionToken(undefined, session, expiresAt)).toBe(false)
  expect(matchesRealtimeSessionToken("not-a-token", session, expiresAt)).toBe(
    false,
  )
})

test("service session projection preserves every recipient fact", async () => {
  const session = {
    userId: "service",
    clientId: "worker",
    orgUnitId: "",
    orgUnitPath: "",
    accessToken: "not-serialized",
    expiresAt: 2_000_000_000,
  }
  expect(
    await getRealtimeRecipientId(toClientSession(session), session.expiresAt),
  ).toBe(await getRealtimeRecipientId(session, session.expiresAt))
})
