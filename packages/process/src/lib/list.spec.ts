import { desc, sql } from "drizzle-orm"
import { PgDialect, integer, pgTable, text } from "drizzle-orm/pg-core"
import { Effect, Schema } from "effect"
import { MetricBreakdown } from "@pf/form-schema"
import { Form } from "./form"
import { List, ListSortable, ListVisibleInList } from "./list"
import {
  type ListQuerySortExpression,
  ListQuerySortFieldNotFoundError,
  listQueryOrderBy,
  listQuerySelectedSortFields,
  listQuerySortField,
  listQuerySortTieBreaker,
} from "./list-query-order-by"
import { OrgUnit } from "./org-unit"
import { normalizePath, pathToPascalCase } from "./org-utils"
import { Organisation } from "./organisation"
import { Process } from "./process"
import { Role } from "./role"
import { describe, expect, it } from "bun:test"

describe("List path normalization", () => {
  function createTestFixtures() {
    const organisation = new Organisation({ name: "Test Organisation" })
    const orgUnit = new OrgUnit(organisation, "primary", {
      name: "Primary Department",
      type: "department",
    })
    const mockRole = new Role(orgUnit, "viewer", { name: "Viewer" })
    return { organisation, orgUnit, mockRole }
  }

  it("should normalize root-level list path from node.path to leading slash format", () => {
    const { organisation, mockRole } = createTestFixtures()

    const list = new List(organisation, "employees", {
      name: "Employees",
      roles: [mockRole],
      output: {
        id: Schema.String,
        name: Schema.String,
      },
      query: () =>
        Effect.succeed({
          items: [],
          totalCount: 0,
        }),
    })

    // node.path is the internal construct path without leading slash
    expect(list.node.path).toBe("employees")

    // normalizePath adds the leading slash
    expect(normalizePath(list.node.path)).toBe("/employees")
  })

  it("should reject lists without roles", () => {
    const { organisation } = createTestFixtures()

    expect(
      () =>
        new List(organisation, "employees", {
          name: "Employees",
          roles: [] as unknown as [Role, ...Role[]],
          output: {
            id: Schema.String,
            name: Schema.String,
          },
          query: () =>
            Effect.succeed({
              items: [],
              totalCount: 0,
            }),
        }),
    ).toThrow("requires at least one role")
  })

  it("should normalize department-level list path from node.path to leading slash format", () => {
    const { orgUnit, mockRole } = createTestFixtures()

    const list = new List(orgUnit, "staff", {
      name: "Staff",
      roles: [mockRole],
      output: {
        id: Schema.String,
        name: Schema.String,
      },
      query: () =>
        Effect.succeed({
          items: [],
          totalCount: 0,
        }),
    })

    // node.path includes the parent org unit path without leading slash
    expect(list.node.path).toBe("primary/staff")

    // normalizePath adds the leading slash
    expect(normalizePath(list.node.path)).toBe("/primary/staff")
  })

  it("should generate consistent query names regardless of path format", () => {
    const { organisation, orgUnit, mockRole } = createTestFixtures()

    const rootList = new List(organisation, "employees", {
      name: "Employees",
      roles: [mockRole],
      output: { id: Schema.String },
      query: () => Effect.succeed({ items: [], totalCount: 0 }),
    })

    const deptList = new List(orgUnit, "staff", {
      name: "Staff",
      roles: [mockRole],
      output: { id: Schema.String },
      query: () => Effect.succeed({ items: [], totalCount: 0 }),
    })

    // queryName uses pathToPascalCase which handles both formats
    expect(rootList.queryName()).toBe("listEmployees")
    expect(deptList.queryName()).toBe("listPrimaryStaff")

    // Verify pathToPascalCase handles both with and without leading slash
    expect(pathToPascalCase("employees")).toBe("Employees")
    expect(pathToPascalCase("/employees")).toBe("Employees")
    expect(pathToPascalCase("primary/staff")).toBe("PrimaryStaff")
    expect(pathToPascalCase("/primary/staff")).toBe("PrimaryStaff")
  })

  it("should generate consistent item query names regardless of path format", () => {
    const { organisation, orgUnit, mockRole } = createTestFixtures()

    const rootList = new List(organisation, "employees", {
      name: "Employees",
      roles: [mockRole],
      output: { id: Schema.String },
      query: () => Effect.succeed({ items: [], totalCount: 0 }),
      form: () => ({ id: Schema.String }),
      itemQuery: () => Effect.succeed(null),
    })

    const deptList = new List(orgUnit, "staff", {
      name: "Staff",
      roles: [mockRole],
      output: { id: Schema.String },
      query: () => Effect.succeed({ items: [], totalCount: 0 }),
      form: () => ({ id: Schema.String }),
      itemQuery: () => Effect.succeed(null),
    })

    // itemQueryName uses pathToPascalCase which handles both formats
    expect(rootList.itemQueryName()).toBe("listItemEmployees")
    expect(deptList.itemQueryName()).toBe("listItemPrimaryStaff")
  })

  it("should expose list form components through a rule-free structured definition", async () => {
    const { organisation, mockRole } = createTestFixtures()

    const list = new List(organisation, "employees", {
      name: "Employees",
      roles: [mockRole],
      output: { id: Schema.String, name: Schema.String },
      query: () => Effect.succeed({ items: [], totalCount: 0 }),
      form: () => ({
        id: Schema.String.annotations({ title: "ID" }),
        name: Schema.String.annotations({ title: "Name" }),
      }),
      itemQuery: () => Effect.succeed(null),
    })

    const definition = await Effect.runPromise(list.clientFormDefinition())

    expect(definition).toEqual({
      components: {
        id: expect.objectContaining({ _tag: "text", field: "id" }),
        name: expect.objectContaining({ _tag: "text", field: "name" }),
      },
      rules: [],
    })
    expect(
      Object.values(definition?.components ?? {}).every(
        (component) => typeof component._tag === "string",
      ),
    ).toBe(true)
  })

  it("should pass selected metric controls to item query context", async () => {
    const { organisation, mockRole } = createTestFixtures()

    const list = new List(organisation, "usage", {
      name: "Usage",
      roles: [mockRole],
      output: { id: Schema.String },
      query: () => Effect.succeed({ items: [], totalCount: 0 }),
      form: () => ({
        id: Schema.String,
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
      itemQuery: (_id, ctx) =>
        Effect.succeed({
          id: ctx?.controls?.["environmentId"] ?? "missing",
          usageCosts: undefined,
        }),
    })

    expect(list.itemQueryControls().map((control) => control.name)).toEqual([
      "environmentId",
    ])
    await expect(
      Effect.runPromise(
        list.executeItemQuery("item-1", {
          controls: { environmentId: "prod" },
        }),
      ),
    ).resolves.toEqual({ id: "prod", usageCosts: undefined })
  })

  it("should ignore controls from non-item-backed metric breakdowns", () => {
    const { organisation, mockRole } = createTestFixtures()

    const list = new List(organisation, "usage", {
      name: "Usage",
      roles: [mockRole],
      output: { id: Schema.String },
      query: () => Effect.succeed({ items: [], totalCount: 0 }),
      form: () => ({
        id: Schema.String,
        usageCosts: MetricBreakdown({
          title: "Usage costs",
          buckets: [{ label: "Compute", amount: 12 }],
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

    expect(list.itemQueryControls()).toEqual([])
  })

  it("should include column visibility metadata from schema annotations", () => {
    const { organisation, mockRole } = createTestFixtures()

    const list = new List(organisation, "employees", {
      name: "Employees",
      roles: [mockRole],
      output: {
        id: Schema.String.annotations({
          title: "ID",
          [ListVisibleInList]: false,
        }),
        name: Schema.String.annotations({ title: "Name" }),
      },
      query: () =>
        Effect.succeed({
          items: [],
          totalCount: 0,
        }),
    })

    expect(list.outputColumns()).toEqual([
      { field: "id", label: "ID", visibleInList: false, sortable: false },
      { field: "name", label: "Name", visibleInList: true, sortable: true },
    ])
  })

  it("should mark only visible scalar output columns sortable", () => {
    const { organisation, mockRole } = createTestFixtures()

    const list = new List(organisation, "employees", {
      name: "Employees",
      roles: [mockRole],
      output: {
        name: Schema.String.annotations({ title: "Name" }),
        score: Schema.Number.annotations({ title: "Score" }),
        active: Schema.Boolean.annotations({ title: "Active" }),
        hireDate: Schema.DateFromString.annotations({ title: "Hire date" }),
        nickname: Schema.NullOr(Schema.String).annotations({
          title: "Nickname",
        }),
        alias: Schema.NullishOr(Schema.String).annotations({ title: "Alias" }),
        hiddenCode: Schema.String.annotations({
          title: "Hidden code",
          [ListVisibleInList]: false,
        }),
        hiddenSortKey: Schema.String.annotations({
          title: "Hidden sort key",
          [ListVisibleInList]: false,
          [ListSortable]: true,
        }),
        neverSort: Schema.String.annotations({
          title: "Never sort",
          [ListSortable]: false,
        }),
        nothing: Schema.Literal(null).annotations({ title: "Nothing" }),
        manager: Schema.Struct({
          name: Schema.String,
        }).annotations({ title: "Manager" }),
        tags: Schema.Array(Schema.String).annotations({ title: "Tags" }),
        jsonManager: Schema.parseJson(
          Schema.Struct({ name: Schema.String }),
        ).annotations({ title: "JSON manager" }),
      },
      query: () => Effect.succeed({ items: [], totalCount: 0 }),
    })

    expect(list.outputColumns()).toEqual([
      { field: "name", label: "Name", visibleInList: true, sortable: true },
      { field: "score", label: "Score", visibleInList: true, sortable: true },
      { field: "active", label: "Active", visibleInList: true, sortable: true },
      {
        field: "hireDate",
        label: "Hire date",
        visibleInList: true,
        sortable: true,
      },
      {
        field: "nickname",
        label: "Nickname",
        visibleInList: true,
        sortable: true,
      },
      {
        field: "alias",
        label: "Alias",
        visibleInList: true,
        sortable: true,
      },
      {
        field: "hiddenCode",
        label: "Hidden code",
        visibleInList: false,
        sortable: false,
      },
      {
        field: "hiddenSortKey",
        label: "Hidden sort key",
        visibleInList: false,
        sortable: true,
      },
      {
        field: "neverSort",
        label: "Never sort",
        visibleInList: true,
        sortable: false,
      },
      {
        field: "nothing",
        label: "Nothing",
        visibleInList: true,
        sortable: false,
      },
      {
        field: "manager",
        label: "Manager",
        visibleInList: true,
        sortable: false,
      },
      { field: "tags", label: "Tags", visibleInList: true, sortable: false },
      {
        field: "jsonManager",
        label: "JSON manager",
        visibleInList: true,
        sortable: false,
      },
    ])
  })

  it("should default export fields to the normal output schema", async () => {
    const { organisation, mockRole } = createTestFixtures()

    const list = new List(organisation, "employees", {
      name: "Employees",
      roles: [mockRole],
      output: {
        id: Schema.String.annotations({ title: "ID" }),
        name: Schema.String.annotations({ title: "Name" }),
      },
      query: () =>
        Effect.succeed({
          items: [{ id: "1", name: "Jane" }],
          totalCount: 1,
        }),
    })

    expect(list.exportFieldNames()).toEqual(["id", "name"])
    expect(list.exportColumns()).toEqual([
      { field: "id", label: "ID", visibleInList: true, sortable: true },
      { field: "name", label: "Name", visibleInList: true, sortable: true },
    ])

    const result = await Effect.runPromise(
      list.executeExportQuery({ page: 1, limit: 10 }),
    )
    expect(result).toEqual({
      items: [{ id: "1", name: "Jane" }],
      totalCount: 1,
    })
  })

  it("should use export-specific schema and query when configured", async () => {
    const { organisation, mockRole } = createTestFixtures()

    const list = new List(organisation, "employees", {
      name: "Employees",
      roles: [mockRole],
      output: {
        id: Schema.String.annotations({ title: "ID" }),
      },
      exportOutput: {
        email: Schema.String.annotations({ title: "Email" }),
      },
      query: () =>
        Effect.succeed({
          items: [{ id: "1" }],
          totalCount: 1,
        }),
      exportQuery: () =>
        Effect.succeed({
          items: [{ email: "jane@example.com" }],
          totalCount: 1,
        }),
    })

    expect(list.exportFieldNames()).toEqual(["email"])
    expect(list.exportColumns()).toEqual([
      { field: "email", label: "Email", visibleInList: true, sortable: true },
    ])

    const result = await Effect.runPromise(
      list.executeExportQuery({ page: 1, limit: 10 }),
    )
    expect(result).toEqual({
      items: [{ email: "jane@example.com" }],
      totalCount: 1,
    })
  })

  it("should reject non-scalar effective export fields during construction", () => {
    const { organisation, mockRole } = createTestFixtures()

    expect(
      () =>
        new List(organisation, "employees", {
          name: "Employees",
          roles: [mockRole],
          output: {
            id: Schema.String,
          },
          exportOutput: {
            metadata: Schema.Struct({ nested: Schema.String }),
          },
          query: () => Effect.succeed({ items: [], totalCount: 0 }),
        }),
    ).toThrow(
      'List /employees export field "metadata" must be a flat scalar value (string, number, boolean, or null)',
    )
  })

  it("should reject export-only fields without an export query", () => {
    const { organisation, mockRole } = createTestFixtures()

    expect(
      () =>
        new List(organisation, "employees", {
          name: "Employees",
          roles: [mockRole],
          output: {
            id: Schema.String,
          },
          exportOutput: {
            email: Schema.String,
          },
          query: () => Effect.succeed({ items: [], totalCount: 0 }),
        }),
    ).toThrow(
      'List /employees export field "email" requires exportQuery because it is not part of the normal list output',
    )
  })

  it("should allow non-scalar normal output when no export override is configured", () => {
    const { organisation, mockRole } = createTestFixtures()

    expect(
      () =>
        new List(organisation, "employees", {
          name: "Employees",
          roles: [mockRole],
          output: {
            metadata: Schema.Struct({ nested: Schema.String }),
          },
          query: () => Effect.succeed({ items: [], totalCount: 0 }),
        }),
    ).not.toThrow()
  })

  it("should allow scalar unions in export fields", () => {
    const { organisation, mockRole } = createTestFixtures()

    expect(
      () =>
        new List(organisation, "employees", {
          name: "Employees",
          roles: [mockRole],
          output: {
            id: Schema.String,
          },
          exportOutput: {
            status: Schema.Union(Schema.String, Schema.Number),
          },
          query: () => Effect.succeed({ items: [], totalCount: 0 }),
          exportQuery: () =>
            Effect.succeed({ items: [{ status: "ready" }], totalCount: 1 }),
        }),
    ).not.toThrow()
  })
})

describe("listQueryOrderBy", () => {
  it("should preserve the default List order when no user sort is requested", () => {
    const employee = pgTable("employee", {
      id: text("id").primaryKey(),
      createdAt: integer("created_at"),
    })
    const defaultOrder = [desc(employee.createdAt), desc(employee.id)]

    const orderBy = listQueryOrderBy({
      fields: { createdAt: employee.createdAt },
      defaultOrder,
    })

    expect(orderBy).toEqual(defaultOrder)
    expect(orderBy).not.toBe(defaultOrder)
  })

  it("should sort strings case-insensitively with null or empty values first for ASC", () => {
    const employee = pgTable("employee", {
      id: text("id").primaryKey(),
      name: text("name"),
    })
    const dialect = new PgDialect()

    const orderBy = listQueryOrderBy({
      sort: { field: "name", direction: "ASC" },
      fields: {
        name: listQuerySortField(employee.name, { caseInsensitive: true }),
      },
      defaultOrder: [desc(employee.id)],
      tieBreaker: employee.id,
    })

    expect(dialect.sqlToQuery(sql.join(orderBy, sql`, `)).sql).toBe(
      `nullif(lower("employee"."name"), '') asc nulls first, "employee"."id" asc`,
    )
  })

  it("should sort strings case-insensitively with null or empty values last for DESC", () => {
    const employee = pgTable("employee", {
      id: text("id").primaryKey(),
      name: text("name"),
    })
    const dialect = new PgDialect()

    const orderBy = listQueryOrderBy({
      sort: { field: "name", direction: "DESC" },
      fields: {
        name: listQuerySortField(employee.name, { caseInsensitive: true }),
      },
      defaultOrder: [desc(employee.id)],
      tieBreaker: employee.id,
    })

    expect(dialect.sqlToQuery(sql.join(orderBy, sql`, `)).sql).toBe(
      `nullif(lower("employee"."name"), '') desc nulls last, "employee"."id" asc`,
    )
  })

  it("should sort selected expressions before pagination", () => {
    const employee = pgTable("employee", {
      id: text("id").primaryKey(),
      department: text("department"),
      score: integer("score"),
    })
    const dialect = new PgDialect()
    const orderBy = listQueryOrderBy({
      sort: { field: "score", direction: "DESC" },
      fields: { score: sql`${employee.score}` },
      defaultOrder: [desc(employee.id)],
      tieBreaker: listQuerySortTieBreaker(employee.id, { direction: "DESC" }),
    })

    const query = dialect.sqlToQuery(
      sql`select * from ${employee} where ${employee.department} = ${"science"} order by ${sql.join(orderBy, sql`, `)} limit ${10} offset ${0}`,
    ).sql

    expect(query.indexOf(" where ")).toBeLessThan(query.indexOf(" order by "))
    expect(query.indexOf(" order by ")).toBeLessThan(query.indexOf(" limit "))
    expect(query).toContain(
      `order by "employee"."score" desc nulls last, "employee"."id" desc`,
    )
  })

  it("should reject user sort fields without configured SQL expressions", () => {
    const employee = pgTable("employee", {
      id: text("id").primaryKey(),
    })

    expect(() =>
      listQueryOrderBy({
        sort: { field: "missing", direction: "ASC" },
        fields: { id: employee.id },
        defaultOrder: [desc(employee.id)],
      }),
    ).toThrow(ListQuerySortFieldNotFoundError)
  })

  it("should sort plain selected columns without nullif wrapping", () => {
    const employee = pgTable("employee", {
      score: integer("score"),
    })
    const dialect = new PgDialect()

    const orderBy = listQueryOrderBy({
      sort: { field: "score", direction: "ASC" },
      fields: { score: employee.score },
      defaultOrder: [],
    })

    expect(orderBy).toHaveLength(1)
    expect(dialect.sqlToQuery(sql.join(orderBy, sql`, `)).sql).toBe(
      `"employee"."score" asc nulls first`,
    )
  })

  it("should derive sort fields from selected output fields", () => {
    const employee = pgTable("employee", {
      id: text("id").primaryKey(),
      name: text("name"),
      department: text("department"),
      score: integer("score"),
    })
    const dialect = new PgDialect()

    const selectedFields = {
      id: employee.id,
      name: employee.name,
      department: employee.department,
      score: employee.score,
    }
    const fields = listQuerySelectedSortFields(selectedFields, {
      exclude: ["id"],
      caseInsensitive: ["name", "department"],
    })

    const orderBy = listQueryOrderBy({
      sort: { field: "name", direction: "ASC" },
      fields,
      defaultOrder: [desc(employee.id)],
      tieBreaker: employee.id,
    })

    expect(() =>
      listQueryOrderBy({
        sort: { field: "id", direction: "ASC" },
        fields,
        defaultOrder: [desc(employee.id)],
      }),
    ).toThrow(ListQuerySortFieldNotFoundError)
    expect(dialect.sqlToQuery(sql.join(orderBy, sql`, `)).sql).toBe(
      `nullif(lower("employee"."name"), '') asc nulls first, "employee"."id" asc`,
    )

    const scoreOrderBy = listQueryOrderBy({
      sort: { field: "score", direction: "ASC" },
      fields,
      defaultOrder: [],
    })
    expect(dialect.sqlToQuery(sql.join(scoreOrderBy, sql`, `)).sql).toBe(
      `"employee"."score" asc nulls first`,
    )
  })

  it("should reject excluded selected fields that are not in the selection", () => {
    const employee = pgTable("employee", {
      id: text("id").primaryKey(),
    })
    const fields: Record<string, ListQuerySortExpression> = { id: employee.id }

    expect(() =>
      listQuerySelectedSortFields(fields, { exclude: ["missing"] }),
    ).toThrow(ListQuerySortFieldNotFoundError)
  })

  it("should reject case-insensitive selected fields that are not in the selection", () => {
    const employee = pgTable("employee", {
      name: text("name"),
    })
    const fields: Record<string, ListQuerySortExpression> = {
      name: employee.name,
    }

    expect(() =>
      listQuerySelectedSortFields(fields, { caseInsensitive: ["missing"] }),
    ).toThrow(ListQuerySortFieldNotFoundError)
  })
})

describe("List process-start button", () => {
  it("derives the label and start path from a configured process", () => {
    const org = new Organisation({ name: "Test" })
    const role = new Role(org, "viewer", { name: "Viewer" })
    const process = new Process(org, "sign-in", {
      name: "Sign-in",
      purpose: "Record attendance",
    })
    const form = new Form(process, "Choose child", {
      name: "Choose child",
      role,
      form: () => ({ child: Schema.String }),
    })
    process.start(form).end()
    const list = new List(org, "attendance", {
      name: "Attendance",
      roles: [role],
      output: { child: Schema.String },
      query: () => Effect.succeed({ items: [], totalCount: 0 }),
      startProcess: process,
    })
    expect(list.startProcess).toEqual({
      path: "/sign-in",
      name: "Sign-in",
      startStepPath: "/sign-in/Choose child",
    })
  })

  it("rejects a process without a start form instead of publishing a broken link", () => {
    const org = new Organisation({ name: "Test" })
    const role = new Role(org, "viewer", { name: "Viewer" })
    const process = new Process(org, "unfinished", {
      name: "Unfinished",
      purpose: "Test",
    })
    expect(
      () =>
        new List(org, "attendance", {
          name: "Attendance",
          roles: [role],
          output: { child: Schema.String },
          query: () => Effect.succeed({ items: [], totalCount: 0 }),
          startProcess: process,
        }),
    ).toThrow("exactly one start form")
  })
})
