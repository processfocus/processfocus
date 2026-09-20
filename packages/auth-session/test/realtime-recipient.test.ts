import {
  getRealtimeRecipientId,
  isAppSyncChannelPath,
  isRealtimeRecipientId,
} from "../src/lib/realtime-recipient"
import type { ProviderUserSession } from "../src/lib/subjects"
import { describe, expect, it } from "bun:test"

const human: ProviderUserSession = {
  userId: "owner",
  email: "owner@example.com",
  orgUnitId: "root",
  orgUnitPath: "/",
  roles: ["/A", "/B"],
}
const delegated: ProviderUserSession = {
  ...human,
  delegation: {
    id: "delegate",
    generationId: "generation",
    name: "Agent",
    expiresAt: 2_000_000_000_000,
  },
}
describe("browser-safe realtime recipient addressing", () => {
  it("isolates all human, delegation and service authority and expiry", async () => {
    const exp = 1_999_999_000
    const original = await getRealtimeRecipientId(delegated, exp)
    const humanRecipient = await getRealtimeRecipientId(human, exp)
    expect(humanRecipient).not.toBe("owner")
    expect(humanRecipient).not.toBe(original)
    expect(
      await getRealtimeRecipientId({ ...human, roles: ["/A"] }, exp),
    ).not.toBe(humanRecipient)
    expect(await getRealtimeRecipientId(human, exp + 1)).not.toBe(
      humanRecipient,
    )
    expect(original).toMatch(/^r3-[A-Za-z0-9]{43}$/)
    const delegation = delegated.delegation!
    const variants: ProviderUserSession[] = [
      { ...delegated, delegation: { ...delegation, id: "another" } },
      {
        ...delegated,
        delegation: { ...delegation, generationId: "replacement" },
      },
      {
        ...delegated,
        delegation: { ...delegation, expiresAt: delegation.expiresAt + 1 },
      },
      { ...delegated, roles: ["/A"] },
      { ...delegated, delegationRoleSelection: ["/A", "/B"] },
      { ...delegated, delegationRoleSelection: [] },
      { ...delegated, orgUnitPath: "/other" },
      { ...delegated, userId: "other-owner" },
    ]
    for (const variant of variants)
      expect(await getRealtimeRecipientId(variant, exp)).not.toBe(original)
    expect(await getRealtimeRecipientId(delegated, exp + 1)).not.toBe(original)
    expect(
      await getRealtimeRecipientId(
        { ...delegated, roles: ["/B", "/A", "/A"] },
        exp,
      ),
    ).toBe(original)
    const service = { userId: "owner", clientId: "client", roles: human.roles }
    expect(await getRealtimeRecipientId(service, exp)).not.toBe(original)
    expect(await getRealtimeRecipientId(service, exp)).not.toBe(human.userId)
    expect(
      await getRealtimeRecipientId({ ...service, clientId: "other" }, exp),
    ).not.toBe(await getRealtimeRecipientId(service, exp))
  })
  it("fails closed without a usable JWT expiry for every actor", async () => {
    for (const exp of [undefined, NaN, Infinity, 0, -1, 1.5]) {
      expect(await getRealtimeRecipientId(human, exp)).toBeUndefined()
      expect(await getRealtimeRecipientId(delegated, exp)).toBeUndefined()
      expect(
        await getRealtimeRecipientId(
          { userId: "owner", clientId: "client" },
          exp,
        ),
      ).toBeUndefined()
    }
  })
})

it.each([
  [1_999_999_001, "gOHk9t3zuT_pz1unIcFDrFUaDTYSqTDBCAO_xLnwL00"],
  [2_000_000_000, "89dH_T3H6dZ1z5RUn_MA-3fgedRRJ3nzEQbazQ50PLQ"],
  // Leading zero digest byte also exercises fixed-width padding.
  [2_000_000_312, "ABBUVd9v2kN5HKGEd_NOUMzK5HAKJz3kCNYh0R4Tdog"],
] as const)(
  "preserves the full formerly underscore-bearing digest at expiry %s",
  async (exp, oldDigest) => {
    const recipient = (await getRealtimeRecipientId(human, exp))!
    expect(isRealtimeRecipientId(recipient)).toBe(true)
    expect(recipient).toHaveLength(46)
    const alphabet =
      "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
    let decoded = 0n
    for (const digit of recipient.slice(3))
      decoded = decoded * 62n + BigInt(alphabet.indexOf(digit))
    expect(decoded.toString(16).padStart(64, "0")).toBe(
      Buffer.from(oldDigest, "base64url").toString("hex"),
    )
    for (const collection of [
      "todo",
      "process",
      "execution",
      "draftProcessExecution",
    ]) {
      expect(
        isAppSyncChannelPath(
          `/rxdb/collection/${collection}/user/r-${oldDigest}`,
        ),
      ).toBe(false)
      expect(
        isAppSyncChannelPath(
          `/rxdb/collection/${collection}/user/${recipient}`,
        ),
      ).toBe(true)
    }
  },
)

it("rejects the production failures and invalid segment boundaries", () => {
  for (const path of [
    "/rxdb/collection/todo/user/r-OpkHcIOgkPMYtdi_u8LptCz2QHPbnJo-ROkn29r_4kQ",
    "/rxdb/collection/todo/user/r-AnoA8YPh_tVsktSu-mNOtbM-v66pD2uJFKB4n2TMDBk",
    "",
    "/",
    "a",
    "/a/",
    "/a/b.c",
    "/a/b c",
    "/a/é",
    "/a/-b",
    "/a/b-",
    "/a//b",
    "/a/b/c/d/e/f",
    `/a/${"b".repeat(51)}`,
  ])
    expect(isAppSyncChannelPath(path)).toBe(false)
  for (const recipient of [
    `r-${"A".repeat(43)}`,
    `r3-${"A".repeat(42)}`,
    `r3-${"A".repeat(44)}`,
    `r3-${"_".repeat(43)}`,
  ])
    expect(isRealtimeRecipientId(recipient)).toBe(false)
})

it("accepts AWS channel grammar limits independently of recipient encoding", () => {
  for (const path of [
    "/a",
    "/A0/b-c",
    `/${"a".repeat(50)}`,
    "/a/b/c/d/e",
    Array.from({ length: 5 }, () => `/${"a".repeat(50)}`).join(""),
  ])
    expect(isAppSyncChannelPath(path)).toBe(true)
})
