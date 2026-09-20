import { Schema as ES, Effect } from "effect"
import { parse } from "graphql"
import { List, Organisation, OrganisationProviderTest, Role } from "@pf/process"
import { buildDynamicSchema } from "../src/lib/org-to-graphql-schema"
import { describe, expect, it } from "bun:test"

describe("org-to-graphql-schema - list sorting", () => {
  const runSchemaBuilder = (org: Organisation): Promise<string> =>
    Effect.runPromise(
      buildDynamicSchema().pipe(Effect.provide(OrganisationProviderTest(org))),
    )

  it("adds the standard optional sort input to generated list queries", async () => {
    const org = new Organisation({ name: "test-org" })
    const role = new Role(org, "viewer")

    new List(org, "employees", {
      name: "Employees",
      roles: [role],
      output: {
        id: ES.String,
        name: ES.String,
      },
      query: () => Effect.succeed({ items: [], totalCount: 0 }),
    })

    const sdl = await runSchemaBuilder(org)

    expect(() => parse(sdl)).not.toThrow()
    expect(sdl).toContain(
      "listEmployees(page: Int! = 1, limit: Int! = 20, filter: String, sort: ListSortInput): EmployeesPage!",
    )
  })
})
