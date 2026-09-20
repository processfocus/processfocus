import { Cause, Schema as ES, Effect, Exit } from "effect"
import { parse } from "graphql"
import { MetricBreakdown } from "@pf/form-schema"
import { List, Organisation, OrganisationProviderTest, Role } from "@pf/process"
import { buildDynamicSchema } from "../src/lib/org-to-graphql-schema"
import { describe, expect, it } from "bun:test"

describe("org-to-graphql-schema - list item query generation", () => {
  const runSchemaBuilder = (org: Organisation): Promise<string> =>
    Effect.runPromise(
      buildDynamicSchema().pipe(Effect.provide(OrganisationProviderTest(org))),
    )

  const runSchemaBuilderExit = (org: Organisation) =>
    Effect.runPromiseExit(
      buildDynamicSchema().pipe(Effect.provide(OrganisationProviderTest(org))),
    )

  it("exposes declared metric controls as safe item query arguments", async () => {
    const org = new Organisation({ name: "test-org" })
    const role = new Role(org, "viewer")

    new List(org, "usage", {
      name: "Usage",
      roles: [role],
      output: { id: ES.String },
      query: () => Effect.succeed({ items: [], totalCount: 0 }),
      form: () => ({
        id: ES.String,
        usageCosts: MetricBreakdown({
          title: "Usage costs",
          dataSource: "item",
          buckets: [{ label: "Compute" }],
          controls: [
            {
              type: "selector",
              name: "environmentId",
              label: "Environment",
              options: [{ label: "Dev", value: "dev" }],
            },
          ],
        }),
      }),
      itemQuery: () => Effect.succeed(null),
    })

    const sdl = await runSchemaBuilder(org)

    expect(() => parse(sdl)).not.toThrow()
    expect(sdl).toContain(
      "listItemUsage(id: String!, environmentId: String): UsageDetail",
    )
  })

  it("rejects unsafe metric control GraphQL argument names", async () => {
    const org = new Organisation({ name: "test-org" })
    const role = new Role(org, "viewer")

    new List(org, "usage", {
      name: "Usage",
      roles: [role],
      output: { id: ES.String },
      query: () => Effect.succeed({ items: [], totalCount: 0 }),
      form: () => ({
        id: ES.String,
        usageCosts: MetricBreakdown({
          title: "Usage costs",
          dataSource: "item",
          buckets: [{ label: "Compute" }],
          controls: [
            {
              type: "selector",
              name: "environment-id",
              label: "Environment",
              options: [{ label: "Dev", value: "dev" }],
            },
          ],
        }),
      }),
      itemQuery: () => Effect.succeed(null),
    })

    const exit = await runSchemaBuilderExit(org)

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.pretty(exit.cause)).toContain("MetricBreakdown control name")
    }
  })

  it("rejects metric controls that collide with the built-in id argument", async () => {
    const org = new Organisation({ name: "test-org" })
    const role = new Role(org, "viewer")

    new List(org, "usage", {
      name: "Usage",
      roles: [role],
      output: { id: ES.String },
      query: () => Effect.succeed({ items: [], totalCount: 0 }),
      form: () => ({
        id: ES.String,
        usageCosts: MetricBreakdown({
          title: "Usage costs",
          dataSource: "item",
          buckets: [{ label: "Compute" }],
          controls: [
            {
              type: "selector",
              name: "id",
              label: "Environment",
              options: [{ label: "Dev", value: "dev" }],
            },
          ],
        }),
      }),
      itemQuery: () => Effect.succeed(null),
    })

    const exit = await runSchemaBuilderExit(org)

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.pretty(exit.cause)).toContain("MetricBreakdown control name")
    }
  })
})
