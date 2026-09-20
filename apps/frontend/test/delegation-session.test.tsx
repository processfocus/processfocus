import { renderToStaticMarkup } from "react-dom/server"
import type { ProviderUserSession } from "@pf/auth-session"
import { DelegationExpiry } from "../components/delegation-expiry"
import { canOpenActOnBehalfMenu } from "../lib/auth/act-on-behalf-menu"
import { toClientSession } from "../lib/auth/client-session"
import { getSessionCacheScope } from "../lib/auth/session-cache-scope"
import { describe, expect, test } from "bun:test"

const human: ProviderUserSession = {
  userId: "owner",
  email: "owner@example.test",
  orgUnitId: "org",
  orgUnitPath: "/",
  roles: ["/Manager", "/Worker"],
}
const delegation = {
  id: "delegate",
  generationId: "generation-1",
  name: "invoice-agent",
  expiresAt: Date.UTC(2030, 0, 1),
}
const delegated: ProviderUserSession = { ...human, delegation }

describe("delegated browser session", () => {
  test("preserves lineage and selected roles but not credentials or human evidence", () => {
    const session = toClientSession({
      ...delegated,
      delegationRoleSelection: ["/Worker"],
      accessToken: "never-send",
      expiresAt: 123,
    })
    expect(session).toEqual({
      ...delegated,
      delegationRoleSelection: ["/Worker"],
    })
    expect(session).not.toHaveProperty("accessToken")
    expect(session).not.toHaveProperty("humanAuthentication")
  })

  test("isolates human, delegation, generation, role and organisation-unit authority", () => {
    const sessions: ProviderUserSession[] = [
      human,
      delegated,
      { ...delegated, delegation: { ...delegation, id: "another-delegate" } },
      {
        ...delegated,
        delegation: { ...delegation, generationId: "generation-2" },
      },
      { ...delegated, roles: ["/Worker"] },
      { ...delegated, delegationRoleSelection: ["/Worker"] },
      { ...delegated, orgUnitPath: "/other" },
      { ...delegated, userId: "other-owner" },
    ]
    expect(new Set(sessions.map(getSessionCacheScope)).size).toBe(
      sessions.length,
    )
  })

  test("normal refresh, role ordering and token renaming do not change authority keys", () => {
    expect(
      getSessionCacheScope({
        ...delegated,
        roles: [...delegated.roles].reverse(),
        delegation: {
          ...delegation,
          name: "renamed",
        },
      }),
    ).toBe(getSessionCacheScope(delegated))
  })

  test("a changed generation deadline resets cached authority", () => {
    expect(
      getSessionCacheScope({
        ...delegated,
        delegation: { ...delegation, expiresAt: delegation.expiresAt - 1000 },
      }),
    ).not.toBe(getSessionCacheScope(delegated))
  })

  test("profile renders the effective deadline as a readable date with timezone", () => {
    const html = renderToStaticMarkup(
      <DelegationExpiry expiresAt={delegation.expiresAt} />,
    )
    expect(html).toContain('dateTime="2030-01-01T00:00:00.000Z"')
    expect(html).toContain("1 Jan 2030, 00:00 UTC")
    expect(html).not.toContain("2030-01-01 00:00:00 UTC")
  })

  test("profile Act on behalf follows listing authorization only", () => {
    expect(canOpenActOnBehalfMenu(undefined)).toBe(false)
    expect(canOpenActOnBehalfMenu({ kind: "denied" })).toBe(false)
    expect(canOpenActOnBehalfMenu({ kind: "error" })).toBe(false)
    expect(canOpenActOnBehalfMenu({ kind: "success" })).toBe(true)
  })
})
