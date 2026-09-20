import type { ProviderUserSession, Session } from "@pf/auth-session"
import { getSessionCacheScope } from "@pf/auth-session/session-cache-scope"
import { assertGraphqlSessionBinding } from "../src/lib/session-binding"
import { describe, expect, test } from "bun:test"

const human: ProviderUserSession = {
  userId: "owner",
  email: "owner@example.test",
  roles: ["/Manager", "/Worker"],
  orgUnitId: "org",
  orgUnitPath: "/",
}
const delegated: ProviderUserSession = {
  ...human,
  delegation: {
    id: "delegate",
    generationId: "one",
    name: "agent",
    expiresAt: 2_000_000_000_000,
  },
  delegationRoleSelection: ["/Worker"],
  roles: ["/Worker"],
}
const scope = getSessionCacheScope(delegated)
const boundRequest = (value = scope) =>
  new Request("https://example.test/graphql", {
    headers: { "x-pf-session-cache-scope": encodeURIComponent(value) },
  })

describe.each([
  {
    name: "WebSocket",
    context: { connectionParams: { sessionCacheScope: scope } },
  },
  { name: "HTTP", context: { request: boundRequest() } },
])("$name verified-session binding", ({ context }) => {
  test("accepts unchanged authority despite token rotation, role ordering and display changes", () => {
    expect(() =>
      assertGraphqlSessionBinding(context, {
        ...delegated,
        roles: [...delegated.roles].reverse(),
        delegation: { ...delegated.delegation!, name: "renamed" },
      }),
    ).not.toThrow()
  })
  test.each([
    { name: "human", session: human },
    { name: "owner", session: { ...delegated, userId: "another-owner" } },
    {
      name: "delegation",
      session: {
        ...delegated,
        delegation: { ...delegated.delegation!, id: "another" },
      },
    },
    {
      name: "generation",
      session: {
        ...delegated,
        delegation: { ...delegated.delegation!, generationId: "two" },
      },
    },
    {
      name: "broader roles",
      session: { ...delegated, roles: ["/Manager", "/Worker"] },
    },
    {
      name: "role selection",
      session: { ...delegated, delegationRoleSelection: undefined },
    },
    { name: "org unit", session: { ...delegated, orgUnitId: "elsewhere" } },
    { name: "service", session: { userId: "owner", clientId: "client" } },
    { name: "missing credential", session: undefined },
  ] satisfies Array<{ name: string; session: Session | undefined }>)(
    "rejects $name before execution",
    ({ session }) => {
      expect(() => assertGraphqlSessionBinding(context, session)).toThrow(
        "Session cache scope changed",
      )
    },
  )
})

test("malformed bindings fail closed, including conflicting HTTP and WS bindings", () => {
  for (const sessionCacheScope of [null, undefined, {}, [], 1, ""]) {
    expect(() =>
      assertGraphqlSessionBinding(
        { connectionParams: { sessionCacheScope } },
        delegated,
      ),
    ).toThrow()
  }
  expect(() =>
    assertGraphqlSessionBinding(
      {
        connectionParams: { sessionCacheScope: scope },
        request: boundRequest(getSessionCacheScope(human)),
      },
      delegated,
    ),
  ).toThrow()
  expect(() =>
    assertGraphqlSessionBinding(
      {
        request: new Request("https://example.test", {
          headers: { "x-pf-session-cache-scope": "%invalid" },
        }),
      },
      delegated,
    ),
  ).toThrow()
})

test("non-caching API clients remain unbound, but cannot authenticate through the binding", () => {
  expect(() => assertGraphqlSessionBinding({}, human)).not.toThrow()
  expect(() =>
    assertGraphqlSessionBinding(
      { connectionParams: { sessionCacheScope: scope } },
      undefined,
    ),
  ).toThrow()
})
