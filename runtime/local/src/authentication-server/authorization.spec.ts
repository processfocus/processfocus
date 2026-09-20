import { resolve } from "node:path"
import { ConfigProvider, DateTime, Effect, Exit, FiberRef } from "effect"
import {
  AuthorizationService,
  DelegationPrincipal,
  ProviderUserPrincipal,
} from "@pf/auth-policy"
import { RequestTime } from "@pf/request-time"
import { AuthenticationAuthorizationLive } from "./authorization"
import { describe, expect, it } from "bun:test"

describe("authentication runtime authorization", () => {
  it("loads explicit demo grants for human Administrators only", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const auth = yield* AuthorizationService
        const administrator = new ProviderUserPrincipal("admin@example.com", {
          roles: ["/Administrator"],
          orgUnitId: "/",
        })
        const ordinary = new ProviderUserPrincipal("ordinary@example.com", {
          roles: ["/Employee"],
          orgUnitId: "/",
        })
        const delegatedAdministrator = new DelegationPrincipal(
          "admin-delegation",
          {
            owner: administrator.uid.id,
            name: "admin-agent",
            roles: ["/Administrator"],
            orgUnitId: "/",
          },
        )
        expect(
          yield* auth.canListDelegationTokens(administrator, administrator),
        ).toBe(true)
        expect(
          yield* auth.canIssueDelegationSecret(administrator, administrator, {
            ownerProviderUserId: "admin",
            humanSession: true,
          }),
        ).toBe(true)
        expect(yield* auth.canListDelegationTokens(ordinary, ordinary)).toBe(
          false,
        )
        expect(
          yield* auth.canIssueDelegationSecret(ordinary, ordinary, {
            ownerProviderUserId: "ordinary",
            humanSession: true,
          }),
        ).toBe(false)
        expect(
          yield* auth.canIssueDelegationSecret(
            delegatedAdministrator,
            administrator,
            { ownerProviderUserId: "admin" },
          ),
        ).toBe(false)
      }).pipe(
        Effect.provide(AuthenticationAuthorizationLive),
        Effect.provideService(
          RequestTime,
          FiberRef.unsafeMake(DateTime.unsafeMake(1_000_000)),
        ),
        Effect.withConfigProvider(
          ConfigProvider.fromMap(
            new Map([
              ["PF_ORG", resolve(import.meta.dir, "../../../../examples/demo")],
            ]),
          ),
        ),
      ),
    )
  })

  it("fails startup rather than substituting defaults for a missing organisation", async () => {
    const exit = await Effect.runPromiseExit(
      AuthorizationService.pipe(
        Effect.provide(AuthenticationAuthorizationLive),
        Effect.withConfigProvider(ConfigProvider.fromMap(new Map())),
      ),
    )
    expect(Exit.isFailure(exit)).toBe(true)
  })
})
