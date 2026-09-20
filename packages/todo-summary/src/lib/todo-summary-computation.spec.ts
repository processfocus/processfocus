import { Effect, Option } from "effect"
import type {
  ProviderUserQueries,
  ProviderUserRow,
} from "@pf/graphql-db-operations"
import { makeProviderUserDisplayResolver } from "./todo-summary-computation"
import { describe, expect, it } from "bun:test"

const providerUser = (
  overrides: Partial<ProviderUserRow>,
): ProviderUserRow => ({
  id: "pvu-1",
  userId: "usr-1",
  email: "ada@example.com",
  name: "Ada Lovelace",
  firstName: "Ada",
  lastName: "Lovelace",
  picture: "",
  locale: "en",
  provider: "auth",
  sub: "sub-1",
  orgUnitId: "ou-1",
  orgUnitPath: "/Operations",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  createdBy: null,
  updatedBy: null,
  ...overrides,
})

const makeResolver = (queries: ProviderUserQueries["Type"]) =>
  Effect.runPromise(makeProviderUserDisplayResolver(queries))

describe("makeProviderUserDisplayResolver", () => {
  it("prefers provider-user name and falls back to email", async () => {
    const emailRow = providerUser({
      id: "pvu-email-input",
      email: "ada@example.com",
      name: "Ada Email",
    })
    const rows = new Map([
      ["pvu-name", providerUser({ id: "pvu-name", name: "Ada Lovelace" })],
      [
        "pvu-email",
        providerUser({
          id: "pvu-email",
          email: "grace@example.com",
          name: "",
        }),
      ],
    ])
    const queries = {
      queryProviderUserByEmail: (email: string) =>
        Effect.succeed(
          email === emailRow.email ? Option.some(emailRow) : Option.none(),
        ),
      queryProviderUserByProviderUserId: (id: string) =>
        Effect.succeed(Option.fromNullable(rows.get(id))),
    } as ProviderUserQueries["Type"]

    const resolver = await makeResolver(queries)

    await expect(Effect.runPromise(resolver.display("pvu-name"))).resolves.toBe(
      "Ada Lovelace",
    )
    await expect(
      Effect.runPromise(resolver.display("pvu-email")),
    ).resolves.toBe("grace@example.com")
    await expect(
      Effect.runPromise(resolver.display("ada@example.com")),
    ).resolves.toBe("Ada Email")
  })

  it("uses the submitted value as the safe fallback for missing users", async () => {
    const queries = {
      queryProviderUserByEmail: () => Effect.succeed(Option.none()),
      queryProviderUserByProviderUserId: () => Effect.succeed(Option.none()),
    } as ProviderUserQueries["Type"]

    const resolver = await makeResolver(queries)

    await expect(
      Effect.runPromise(resolver.display("deleted-user")),
    ).resolves.toBe("deleted-user")
  })

  it("uses the submitted value as the safe fallback for lookup failures", async () => {
    const queries = {
      queryProviderUserByEmail: () => Effect.die("unexpected email lookup"),
      queryProviderUserByProviderUserId: () =>
        Effect.fail(new Error("db down")),
    } as ProviderUserQueries["Type"]

    const resolver = await makeResolver(queries)

    await expect(
      Effect.runPromise(resolver.display("pvu-unavailable")),
    ).resolves.toBe("pvu-unavailable")
  })

  it("uses the submitted email as the safe fallback for lookup defects", async () => {
    const queries = {
      queryProviderUserByEmail: () => Effect.die("db defect"),
      queryProviderUserByProviderUserId: () =>
        Effect.die("unexpected id lookup"),
    } as ProviderUserQueries["Type"]

    const resolver = await makeResolver(queries)

    await expect(
      Effect.runPromise(resolver.display("unavailable@example.com")),
    ).resolves.toBe("unavailable@example.com")
  })

  it("dedupes concurrent display lookups for the same key to one query", async () => {
    let callCount = 0
    const queries = {
      queryProviderUserByEmail: () => Effect.die("unexpected email lookup"),
      queryProviderUserByProviderUserId: (id: string) =>
        Effect.gen(function* () {
          callCount += 1
          // Yield so concurrent callers can race the cache miss path.
          yield* Effect.sleep("20 millis")
          return Option.some(
            providerUser({
              id,
              name: "Ada Lovelace",
              email: "ada@example.com",
            }),
          )
        }),
    } as ProviderUserQueries["Type"]

    const resolver = await makeResolver(queries)

    const [first, second] = await Effect.runPromise(
      Effect.all(
        [resolver.display("pvu-shared"), resolver.display("pvu-shared")],
        { concurrency: "unbounded" },
      ),
    )

    expect(first).toBe("Ada Lovelace")
    expect(second).toBe("Ada Lovelace")
    expect(callCount).toBe(1)
  })
})
