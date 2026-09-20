import { describe, expect, test } from "vitest"
import { toClientSession } from "../lib/auth/client-session"

describe("toClientSession", () => {
  test("removes server-only fields from provider user sessions", () => {
    const serverSession = {
      userId: "user-1",
      email: "user@example.com",
      orgUnitId: "org-1",
      orgUnitPath: "/",
      roles: ["Manager"],
      accessToken: "secret-token",
      expiresAt: 123,
    }

    const clientSession = toClientSession(serverSession)

    expect(clientSession).toEqual({
      userId: "user-1",
      email: "user@example.com",
      orgUnitId: "org-1",
      orgUnitPath: "/",
      roles: ["Manager"],
    })
    expect("accessToken" in clientSession).toBe(false)
    expect("expiresAt" in clientSession).toBe(false)
  })

  test("preserves optional service-session fields without leaking tokens", () => {
    const serverSession = {
      userId: "service-1",
      clientId: "ci-pipeline",
      roles: ["Admin"],
      orgUnitId: "org-2",
      orgUnitPath: "/ops",
      accessToken: "secret-token",
      expiresAt: 123,
    }

    const clientSession = toClientSession(serverSession)

    expect(clientSession).toEqual({
      userId: "service-1",
      clientId: "ci-pipeline",
      roles: ["Admin"],
      orgUnitId: "org-2",
      orgUnitPath: "/ops",
    })
    expect("accessToken" in clientSession).toBe(false)
  })

  test("omits absent optional fields from service sessions", () => {
    const serverSession = {
      userId: "service-1",
      clientId: "ci-pipeline",
      accessToken: "secret-token",
      expiresAt: 123,
    }

    const clientSession = toClientSession(serverSession)

    expect(clientSession).toEqual({
      userId: "service-1",
      clientId: "ci-pipeline",
    })
    expect("roles" in clientSession).toBe(false)
    expect("orgUnitId" in clientSession).toBe(false)
    expect("orgUnitPath" in clientSession).toBe(false)
  })
})
