import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { NodeFileSystem } from "@effect/platform-node"
import {
  DateTime,
  Effect,
  FileSystem,
  Layer,
  ManagedRuntime,
  Schema,
} from "effect"
import { SqlClient } from "effect/sql"
import { createSchema, createYoga } from "graphql-yoga"
import {
  LocalCedarAuthorizationLive,
  LocalCedarConfig,
  getDefaultPoliciesPath,
  getDefaultSchemaPath,
} from "@pf/auth-local-cedar"
import { FormDefault, TextBlock, TextField, Wrapper } from "@pf/form-schema"
import { buildDynamicSchema } from "@pf/org-to-graphql-schema"
import {
  List,
  type ListQueryContext,
  ListSortable,
  Organisation,
  OrganisationProvider,
  Role,
} from "@pf/process"
import { DatabaseTest } from "@pf/service-drizzle-sqlite/test"
import { SqliteGraphqlDbOperationsLive } from "@pf/sqlite-operations"
import { transformSchemaWithAuthDirective } from "../../../../packages/graphql-api/src/lib/auth-directive-plugin"
import { dynamicSchema } from "../../../../packages/graphql-api/src/lib/dynamic-resolvers"
import { DynamicSchemaConfig } from "../../../../packages/graphql-api/src/lib/graphql-api"
import { createResolverExecutor } from "../../../../packages/graphql-api/src/lib/resolver-utils"
import { systemSchema } from "../../../../packages/graphql-api/src/lib/system-resolvers"
import type { UserContext } from "../../../../packages/graphql-api/src/lib/types"
import { expect, it } from "bun:test"

it("describes caller capabilities and schema facts through Yoga, Cedar and SQLite", async () => {
  const org = new Organisation({ name: "List discovery" })
  const employee = new Role(org, "Employee")
  const manager = new Role(org, "Manager")
  const fields = {
    group: Wrapper({
      name: TextField({ description: "Display name", default: "New record" }),
      category: Schema.Literals(["Member", "Guest"]),
    }),
    secret: TextField({
      permission: { modify: manager },
      default: "private default",
    }),
    summary: TextField({ readOnly: true }),
    explanation: TextBlock("Instructions"),
  }
  const browser = { entrypoint: "forms.ts", exportName: "form" }
  const row = Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    category: Schema.String,
    secret: Schema.String,
  })
  const query = (context: ListQueryContext) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const filter = `%${context.filter ?? ""}%`
      const rows = yield* Schema.decodeUnknownEffect(Schema.Array(row))(
        context.sort?.direction === "DESC"
          ? yield* sql`SELECT * FROM metadata_records WHERE name LIKE ${filter} ORDER BY name DESC`
          : yield* sql`SELECT * FROM metadata_records WHERE name LIKE ${filter} ORDER BY name ASC`,
      )
      return {
        items: rows.slice(
          (context.page - 1) * context.limit,
          context.page * context.limit,
        ),
        totalCount: rows.length,
      }
    }).pipe(Effect.orDie)
  const itemQuery = (id: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql`SELECT * FROM metadata_records WHERE id = ${id}`
      return rows[0]
        ? {
            ...(yield* Schema.decodeUnknownEffect(row)(rows[0])),
            detailOnly: "detail",
          }
        : null
    }).pipe(Effect.orDie)
  const create = {
    browser,
    form: () => fields,
    submit: (input: { name: string; category: string; secret: string }) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`INSERT INTO metadata_records VALUES ('new', ${input.name}, ${input.category}, ${input.secret})`
        return "new"
      }).pipe(Effect.orDie),
  }
  // Nullable fields exercise the existing supplied-field update contract.
  const edit = {
    id: TextField({ readOnly: true }),
    name: Schema.NullOr(Schema.String).annotate({
      [FormDefault]: "Edit default",
    }),
    detailOnly: TextField({ readOnly: true }),
  }
  const update = (id: string, input: { name: string | null }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      if (Object.hasOwn(input, "name"))
        yield* sql`UPDATE metadata_records SET name = ${input.name} WHERE id = ${id}`
      return { id, name: input.name, detailOnly: "detail" }
    }).pipe(Effect.orDie)
  const deletion = (id: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`DELETE FROM metadata_records WHERE id = ${id}`
    }).pipe(Effect.orDie)
  for (const variant of [
    "readonly",
    "detailonly",
    "createonly",
    "updateonly",
    "deleteonly",
    "all",
    "hidden",
    "updatewithoutform",
  ]) {
    new List(org, variant, {
      name: variant,
      roles: [employee],
      output: {
        id: Schema.String,
        name: Schema.String.annotate({ [ListSortable]: true }),
      },
      query,
      ...(variant === "all" || variant === "createonly" ? { create } : {}),
      ...(variant === "all" ||
      variant === "updateonly" ||
      variant === "detailonly"
        ? { form: () => edit, browser, itemQuery }
        : {}),
      ...(variant === "all" ||
      variant === "updateonly" ||
      variant === "updatewithoutform"
        ? { update }
        : {}),
      ...(variant === "all" || variant === "deleteonly"
        ? { delete: deletion }
        : {}),
    })
  }
  const choiceFields = {
    decisions: Schema.Array(Schema.Literals(["approve", "reject"])),
    notes: Schema.Array(Schema.String),
  }
  new List(org, "choices", {
    name: "Choices",
    roles: [employee],
    output: { id: Schema.String },
    query: () => Effect.succeed({ items: [], totalCount: 0 }),
    browser,
    form: () => choiceFields,
    create: {
      browser,
      form: () => choiceFields,
      submit: () => Effect.succeed("new"),
    },
    update: (_id, input) => Effect.succeed(input),
  })
  new List(org, "cli", {
    name: "CLI mutations",
    roles: [employee],
    output: { id: Schema.String },
    query: () => Effect.succeed({ items: [], totalCount: 0 }),
    browser,
    form: () => edit,
    itemQuery: () => Effect.succeed(null),
    create: {
      browser,
      form: () => ({ name: TextField({}).check(Schema.isMinLength(2)) }),
      submit: (input) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* sql`INSERT INTO metadata_records VALUES ('cli', ${input.name}, 'Member', 'kept')`
          return "cli"
        }).pipe(Effect.orDie),
    },
    update: (id, input) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        if (Object.hasOwn(input, "name"))
          yield* sql`UPDATE metadata_records SET name = ${input.name} WHERE id = ${id}`
        if (input.name === null) return null
        return {
          id,
          name: input.name ?? "unchanged",
          detailOnly: "callback result",
        }
      }).pipe(Effect.orDie),
    delete: (id) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE metadata_records SET category = 'Archived' WHERE id = ${id}`
      }).pipe(Effect.orDie),
  })
  const orgLayer = Layer.succeed(OrganisationProvider, {
    organisation: org,
    orgPath: "/tmp/metadata",
    schemaPath: "/tmp/metadata.graphql",
  })
  const auth = LocalCedarAuthorizationLive.pipe(
    Layer.provide(
      Layer.succeed(LocalCedarConfig, {
        schemaText: readFileSync(getDefaultSchemaPath(), "utf8"),
        policiesText: [
          readFileSync(getDefaultPoliciesPath(), "utf8"),
          'permit(principal, action == PF::Action::"delete", resource is PF::List);',
          'permit(principal == PF::ProviderUser::"fieldforbid@example.com", action == PF::Action::"create", resource);',
          'forbid(principal == PF::ProviderUser::"fieldforbid@example.com", action == PF::Action::"modifyField", resource);',
          'permit(principal == PF::ProviderUser::"fielddenied@example.com", action == PF::Action::"create", resource);',
          'permit(principal == PF::ProviderUser::"allowed@example.com", action == PF::Action::"create", resource);',
          'permit(principal == PF::ProviderUser::"forbidden@example.com", action == PF::Action::"create", resource);',
          'forbid(principal == PF::ProviderUser::"forbidden@example.com", action in [PF::Action::"create", PF::Action::"update", PF::Action::"delete"], resource);',
          'forbid(principal, action == PF::Action::"view", resource == PF::List::"/hidden");',
          'forbid(principal == PF::ProviderUser::"empty@example.com", action == PF::Action::"view", resource is PF::List);',
          'forbid(principal == PF::ProviderUser::"readforbid@example.com", action == PF::Action::"query", resource == PF::GraphQLField::"Query.listItemAll");',
          'forbid(principal == PF::ProviderUser::"rootforbid@example.com", action == PF::Action::"mutation", resource == PF::GraphQLField::"Mutation.deleteListItemAll");',
        ],
      }),
    ),
  )
  const database = SqliteGraphqlDbOperationsLive.pipe(
    Layer.provideMerge(DatabaseTest),
  )
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(orgLayer, auth, database, NodeFileSystem.layer),
  )
  const context = (email: string): UserContext => ({
    userId: email,
    _requestTime: DateTime.makeUnsafe("2026-10-17T00:00:00Z"),
    _userDetails: { id: email, by: email },
    jwt: {
      mode: "access",
      type: "user",
      properties: {
        userId: email,
        email,
        roles: [
          "/Employee",
          ...(["allowed@example.com", "fieldforbid@example.com"].includes(email)
            ? ["/Manager"]
            : []),
        ],
        orgUnitId: "/",
        orgUnitPath: "/",
      },
      aud: "graphql-api",
      iss: "test",
      sub: email,
      exp: 0,
      iat: 0,
    },
  })
  try {
    const generated = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`CREATE TABLE metadata_records (id TEXT PRIMARY KEY, name TEXT, category TEXT, secret TEXT)`
        const sdl = yield* buildDynamicSchema()
        return yield* dynamicSchema.pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(DynamicSchemaConfig, {
                schemaPath: "/tmp/metadata.graphql",
              }),
              Layer.succeed(
                FileSystem.FileSystem,
                FileSystem.makeNoop({
                  exists: () => Effect.succeed(true),
                  readFileString: () => Effect.succeed(sdl),
                }),
              ),
            ),
          ),
        )
      }),
    )
    const system = await runtime.runPromise(systemSchema)
    const executor = createResolverExecutor(runtime)
    const schema = transformSchemaWithAuthDirective(
      createSchema<UserContext>({
        typeDefs: [
          readFileSync(
            new URL(
              "../../../../packages/graphql-schema/graphql/rxdb.graphql",
              import.meta.url,
            ),
            "utf8",
          ),
          system.typeDefs,
          generated.typeDefs,
        ],
        resolvers: {
          ...system.resolvers,
          Query: { ...system.resolvers?.Query, ...generated.resolvers?.Query },
          Mutation: {
            ...system.resolvers?.Mutation,
            ...generated.resolvers?.Mutation,
          },
        },
      }),
      executor,
    )
    const yoga = createYoga({
      schema,
      context: ({ request }) =>
        context(
          request.headers.get("x-test-user") ??
            request.headers.get("authorization")?.replace("Bearer ", "") ??
            "allowed@example.com",
        ),
      logging: false,
    })
    const execute = async (
      query: string,
      variables: Record<string, unknown> = {},
      email = "allowed@example.com",
    ) => {
      const response = await yoga.fetch(
        new Request("http://localhost/graphql", {
          method: "POST",
          headers: { "content-type": "application/json", "x-test-user": email },
          body: JSON.stringify({ query, variables }),
        }),
      )
      return response.json()
    }
    const operation = `configured authorized name arguments { name type required hasDefault defaultValue fields { name type required description enumValues hasDefault defaultValue } } result { type fields { name type fields { name } } }`
    const describe = (path: string, email?: string) =>
      execute(
        `query($path: String!) { listMetadata(listPath: $path) { path browse { ${operation} } detail { ${operation} } create { ${operation} } update { ${operation} } delete { ${operation} } } }`,
        { path },
        email,
      )
    const choices = await describe("/choices")
    expect(choices.errors).toBeUndefined()
    for (const operation of ["create", "update"]) {
      expect(
        choices.data.listMetadata[operation].arguments.find(
          (arg: { name: string }) => arg.name === "input",
        ).fields,
      ).toEqual([
        expect.objectContaining({
          name: "decisions",
          type: "[String!]!",
          enumValues: ["approve", "reject"],
        }),
        expect.objectContaining({
          name: "notes",
          type: "[String!]!",
          enumValues: [],
        }),
      ])
    }
    const discovered = await execute(
      "{ availableLists { path canCreate queryName itemQueryName editableColumns { field } } }",
    )
    expect(discovered.errors).toBeUndefined()
    expect(
      discovered.data.availableLists.map((list: { path: string }) => list.path),
    ).not.toContain("/hidden")
    for (const path of ["/hidden", "/missing"])
      expect((await describe(path)).data.listMetadata).toBeNull()
    const metadata = await describe("/all")
    expect(metadata.errors).toBeUndefined()
    const all = metadata.data.listMetadata
    for (const name of ["browse", "detail", "create", "update", "delete"])
      expect(all[name]).toMatchObject({ configured: true, authorized: true })
    expect(
      all.browse.result.fields.find(
        (field: { name: string }) => field.name === "items",
      ).fields,
    ).toEqual([{ name: "id" }, { name: "name" }])
    expect(
      all.detail.result.fields.map((field: { name: string }) => field.name),
    ).toEqual(["id", "name", "detailOnly"])
    const input = all.create.arguments[0].fields
    expect(input.map((field: { name: string }) => field.name)).toEqual([
      "name",
      "category",
      "secret",
    ])
    expect(input[0]).toMatchObject({
      type: "String!",
      required: true,
      description: "Display name",
      hasDefault: true,
      defaultValue: "New record",
    })
    expect(input[1].enumValues).toEqual(["Member", "Guest"])
    expect(input[1].hasDefault).toBe(false)
    expect(all.browse.arguments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "page",
          type: "Int!",
          required: false,
          hasDefault: true,
          defaultValue: 1,
        }),
        expect.objectContaining({ name: "filter", type: "String" }),
        expect.objectContaining({ name: "sort", type: "ListSortInput" }),
      ]),
    )
    expect(
      (await execute('mutation { deleteListItemReadonly(id: "new") }'))
        .errors[0].message,
    ).toContain("Cannot query field")
    expect(
      all.update.arguments.find((arg: { name: string }) => arg.name === "input")
        .fields,
    ).toEqual([
      expect.objectContaining({
        name: "name",
        type: "String",
        required: false,
        hasDefault: true,
        defaultValue: "Edit default",
      }),
    ])
    for (const [path, enabled] of [
      ["/readonly", []],
      ["/detailonly", ["detail"]],
      ["/createonly", ["create"]],
      ["/updateonly", ["detail", "update"]],
      ["/deleteonly", ["delete"]],
      ["/updatewithoutform", []],
    ] as const) {
      const result = (await describe(path)).data.listMetadata
      for (const name of ["detail", "create", "update", "delete"])
        expect(result[name].configured).toBe(
          enabled.some((entry) => entry === name),
        )
    }
    const forbidden = (await describe("/all", "forbidden@example.com")).data
      .listMetadata
    for (const name of ["create", "update", "delete"])
      expect(forbidden[name]).toMatchObject({
        configured: true,
        authorized: false,
        arguments: [],
        result: null,
      })
    expect(
      (await describe("/all", "rootforbid@example.com")).data.listMetadata
        .delete.authorized,
    ).toBe(false)
    const explicitFieldForbid = (
      await describe("/all", "fieldforbid@example.com")
    ).data.listMetadata.create
    expect(explicitFieldForbid.authorized).toBe(true)
    expect(
      explicitFieldForbid.arguments[0].fields.map(
        (field: { name: string }) => field.name,
      ),
    ).toEqual(["name", "category"])
    const fieldDenied = (await describe("/all", "fielddenied@example.com")).data
      .listMetadata.create
    expect(fieldDenied.authorized).toBe(true)
    expect(
      fieldDenied.arguments[0].fields.map(
        (field: { name: string }) => field.name,
      ),
    ).toEqual(["name", "category"])
    expect(JSON.stringify(fieldDenied)).not.toContain("private default")
    const viewer = (await describe("/all", "viewer@example.com")).data
      .listMetadata
    expect(viewer.create).toMatchObject({ configured: true, authorized: false })
    const createMutation =
      "mutation($input: CreateAll!) { createListItemAll(input: $input) }"
    const values = { name: "Alex", category: "Member", secret: "private" }
    expect(
      (await execute(createMutation, { input: values }, "viewer@example.com"))
        .errors,
    ).toBeDefined()
    for (const query of [
      createMutation,
      'mutation { updateListItemAll(id: "new", input: {name: "Denied"}) { id } }',
      'mutation { deleteListItemAll(id: "new") }',
    ]) {
      expect(
        (await execute(query, { input: values }, "forbidden@example.com"))
          .errors,
      ).toBeDefined()
    }
    expect(
      (
        await execute(
          createMutation,
          { input: values },
          "fielddenied@example.com",
        )
      ).errors,
    ).toBeDefined()
    expect(
      (
        await execute(
          createMutation,
          { input: values },
          "fieldforbid@example.com",
        )
      ).errors[0].message,
    ).toMatch(/not authorized to modify field secret/i)
    expect(
      (await execute(createMutation, { input: values })).data.createListItemAll,
    ).toBe("new")
    // The CLI process must discover and execute the real generated operations.
    // API-only assertions above cannot catch command registration, selection
    // construction, flag forwarding, or stdout/stderr/exit regressions.
    const cliRoot = mkdtempSync(join(tmpdir(), "pforg-list-reads-"))
    const server = Bun.serve({
      hostname: "localhost",
      port: 0,
      fetch: (request) => yoga.fetch(request),
    })
    const credentialsPath = join(cliRoot, "credentials.json")
    writeFileSync(
      join(cliRoot, ".graphql-port.json"),
      JSON.stringify({ port: server.port }),
    )
    const cli = async (args: string[], user = "allowed@example.com") => {
      writeFileSync(
        credentialsPath,
        JSON.stringify({
          version: 1,
          baseUrl: "http://localhost:3000",
          accessToken: user,
          expiresAt: "2999-01-01T00:00:00Z",
          loginAt: "2026-10-17T00:00:00Z",
        }),
      )
      const child = Bun.spawn(
        [
          process.execPath,
          resolve(import.meta.dir, "../../../../cli/pforg/src/main.ts"),
          ...args,
        ],
        {
          env: {
            ...process.env,
            PFORG_CREDENTIALS_PATH: credentialsPath,
            PF_RUNTIME_ROOT: cliRoot,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      return { stdout, stderr, exitCode }
    }
    const success = async (args: string[], user?: string) => {
      const result = await cli(args, user)
      expect(result).toMatchObject({ exitCode: 0, stderr: "" })
      return JSON.parse(result.stdout)
    }
    try {
      expect(await success(["lists", "list"], "empty@example.com")).toEqual([])
      const discovered = await success(["lists", "list"], "viewer@example.com")
      expect(
        discovered.map((list: { path: string }) => list.path),
      ).not.toContain("/hidden")
      expect(
        discovered.find((list: { path: string }) => list.path === "/all")
          .create,
      ).toMatchObject({ configured: true, authorized: false, arguments: [] })
      const description = await success(["lists", "describe", "/all"])
      expect(description.create.arguments[0].fields).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "name",
            type: "String!",
            required: true,
            description: "Display name",
            hasDefault: true,
            defaultValue: "New record",
          }),
          expect.objectContaining({
            name: "category",
            enumValues: ["Member", "Guest"],
          }),
        ]),
      )
      const restricted = await success(
        ["lists", "describe", "/all"],
        "fielddenied@example.com",
      )
      expect(
        restricted.create.arguments[0].fields.map(
          (field: { name: string }) => field.name,
        ),
      ).not.toContain("secret")
      expect(await success(["records", "list", "/all"])).toEqual({
        items: [{ id: "new", name: "Alex" }],
        page: 1,
        limit: 20,
        totalCount: 1,
        hasNextPage: false,
      })
      expect(await success(["records", "get", "/all", "new"])).toEqual({
        id: "new",
        name: "Alex",
        detailOnly: "detail",
      })
      expect(await success(["records", "get", "/all", "missing"])).toBeNull()
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* sql`INSERT INTO metadata_records VALUES ('second', 'Zoe', 'Member', 'private')`
        }),
      )
      expect(
        await success([
          "records",
          "list",
          "/all",
          "--limit",
          "1",
          "--sort",
          '{"field":"name","direction":"DESC"}',
        ]),
      ).toEqual({
        items: [{ id: "second", name: "Zoe" }],
        page: 1,
        limit: 1,
        totalCount: 2,
        hasNextPage: true,
      })
      expect(
        await success([
          "records",
          "list",
          "/all",
          "--page",
          "2",
          "--limit",
          "1",
          "--sort",
          '{"field":"name","direction":"DESC"}',
        ]),
      ).toEqual({
        items: [{ id: "new", name: "Alex" }],
        page: 2,
        limit: 1,
        totalCount: 2,
        hasNextPage: false,
      })
      expect(
        (await success(["records", "list", "/all", "--filter", "Zoe"])).items,
      ).toEqual([{ id: "second", name: "Zoe" }])
      expect(
        await success(["records", "list", "/all", "--filter", "absent"]),
      ).toEqual({
        items: [],
        page: 1,
        limit: 20,
        totalCount: 0,
        hasNextPage: false,
      })
      for (const { args, user, code } of [
        {
          args: ["records", "get", "/readonly", "new"],
          code: "OPERATION_UNAVAILABLE",
        },
        {
          args: ["records", "get", "/all", "new"],
          user: "readforbid@example.com",
          code: "PERMISSION_DENIED",
        },
        { args: ["records", "list", "/hidden"], code: "LIST_UNAVAILABLE" },
        { args: ["lists", "describe", "/missing"], code: "LIST_UNAVAILABLE" },
        {
          args: ["records", "list", "/all", "--sort", "broken"],
          code: "INVALID_ARGUMENT",
        },
        {
          args: [
            "records",
            "list",
            "/all",
            "--sort",
            '{"field":"secret","direction":"ASC"}',
          ],
          code: "REQUEST_FAILED",
        },
        {
          args: ["records", "list", "/all", "--page", "0"],
          code: "INVALID_ARGUMENT",
        },
        {
          args: ["records", "list", "/all", "--page", "oops"],
          code: "COMMAND_FAILED",
        },
        { args: ["records", "get", "/all"], code: "COMMAND_FAILED" },
      ]) {
        const result = await cli(args, user)
        expect(result).toMatchObject({ exitCode: 1, stdout: "" })
        expect(JSON.parse(result.stderr)).toMatchObject({
          error: { code, message: expect.any(String) },
        })
        expect(result.stderr).not.toContain(user ?? "allowed@example.com")
      }
    } finally {
      server.stop(true)
      rmSync(cliRoot, { recursive: true, force: true })
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          yield* sql`DELETE FROM metadata_records WHERE id = 'second'`
        }),
      )
    }
    expect(
      (
        await execute(
          "{ listAll { items { id name } totalCount page limit hasNextPage } }",
        )
      ).data.listAll.items,
    ).toEqual([{ id: "new", name: "Alex" }])
    expect(
      (await execute('{ listItemAll(id: "new") { id name detailOnly } }')).data
        .listItemAll,
    ).toEqual({ id: "new", name: "Alex", detailOnly: "detail" })
    expect(
      (
        await execute(
          'mutation { updateListItemAll(id: "new", input: {name: "Updated"}) { id name } }',
        )
      ).data.updateListItemAll,
    ).toEqual({ id: "new", name: "Updated" })
    expect(
      (
        await execute(
          'mutation { deleteListItemAll(id: "new") }',
          {},
          "rootforbid@example.com",
        )
      ).errors,
    ).toBeDefined()
    expect(
      (await execute('mutation { deleteListItemAll(id: "new") }')).data
        .deleteListItemAll,
    ).toBe(true)
    expect(
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          return yield* sql`SELECT * FROM metadata_records`
        }),
      ),
    ).toEqual([])
    // This subprocess boundary protects CLI parsing, variables and result rendering;
    // the existing API assertions above own metadata and resolver contracts.
    const root = mkdtempSync(join(tmpdir(), "pforg-records-"))
    let identity = "allowed@example.com"
    let staleDiscovery = false
    const requests: string[] = []
    const mutationServer = Bun.serve({
      port: 0,
      async fetch(request) {
        expect(request.headers.get("authorization")).toBe(
          "Bearer fixture-token",
        )
        const body = await request.clone().text()
        requests.push(body)
        const headers = new Headers(request.headers)
        headers.set(
          "x-test-user",
          staleDiscovery && body.includes("mutation(")
            ? "forbidden@example.com"
            : identity,
        )
        return yoga.fetch(new Request(request, { headers }))
      },
    })
    writeFileSync(
      join(root, ".graphql-port.json"),
      JSON.stringify({ port: mutationServer.port }),
    )
    writeFileSync(
      join(root, "credentials.json"),
      JSON.stringify({
        version: 1,
        baseUrl: "http://localhost:3000",
        accessToken: "fixture-token",
        expiresAt: "2999-01-01T00:00:00Z",
        loginAt: "2026-10-17T00:00:00Z",
      }),
    )
    const run = async (args: string[], stdin = "") => {
      requests.length = 0
      const child = Bun.spawn(
        [process.execPath, "cli/pforg/src/main.ts", "records", ...args],
        {
          cwd: new URL("../../../../", import.meta.url).pathname,
          env: {
            ...process.env,
            PFORG_CREDENTIALS_PATH: join(root, "credentials.json"),
            PF_RUNTIME_ROOT: root,
          },
          stdin: new TextEncoder().encode(stdin),
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(stdout + stderr).not.toContain("fixture-token")
      return { stdout, stderr, code }
    }
    const succeeds = (
      result: { stdout: string; stderr: string; code: number },
      data: unknown,
    ) => {
      expect(result).toEqual({
        stdout: `${JSON.stringify(data)}\n`,
        stderr: "",
        code: 0,
      })
      expect(requests).toHaveLength(2) // discovery and mutation, no fetch or retry
    }
    const fails = (
      result: { stdout: string; stderr: string; code: number },
      message: RegExp,
    ) => {
      expect(result.code).toBe(1)
      expect(result.stdout).toBe("")
      expect(JSON.parse(result.stderr)).toMatchObject({
        error: {
          code: "COMMAND_FAILED",
          message: expect.stringMatching(message),
        },
      })
    }
    const rows = () =>
      runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          return yield* sql`SELECT * FROM metadata_records WHERE id = 'cli'`
        }),
      )
    try {
      for (const args of [
        ["create", "/cli"],
        ["create", "/cli", "--input", "{}", "--input-stdin"],
        ["update", "/cli", "cli", "--input", "{}", "--input-file", "missing"],
      ]) {
        fails(await run(args), /exactly one/)
        expect(requests).toHaveLength(0)
      }
      for (const input of ["{", "null", "[]"]) {
        fails(
          await run(["create", "/cli", "--input", input]),
          /valid JSON containing an object/,
        )
        expect(requests).toHaveLength(0)
      }
      fails(
        await run(["create", "/cli", "--input-file", join(root, "missing")]),
        /Could not read/,
      )
      fails(await run(["update", "/cli"]), /record-id/)
      for (const kind of ["create", "update", "delete"]) {
        const args = [
          kind,
          "/readonly",
          ...(kind === "create" ? [] : ["cli"]),
          ...(kind === "delete" ? [] : ["--input", '{"name":"Valid"}']),
        ]
        fails(await run(args), /no authored/)
        expect(requests).toHaveLength(1)
        args[1] = "/cli"
        identity = "forbidden@example.com"
        fails(await run(args), /not authorized/)
        expect(requests).toHaveLength(1)
        identity = "allowed@example.com"
        staleDiscovery = true
        fails(await run(args), /GraphQL error/)
        expect(requests).toHaveLength(2)
        staleDiscovery = false
      }
      fails(
        await run(["delete", "/missing", "cli"]),
        /not found or not accessible/,
      )
      fails(
        await run(["create", "/cli", "--input", '{"name":"x"}']),
        /GraphQL error/,
      )
      fails(
        await run(["create", "/cli", "--input", '{"name":null}']),
        /GraphQL error/,
      )
      fails(
        await run([
          "create",
          "/cli",
          "--input",
          '{"name":"Name","extra":true}',
        ]),
        /GraphQL error/,
      )
      succeeds(
        await run(["create", "/cli", "--input", '{"name":"Original"}']),
        { id: "cli", data: "cli" },
      )
      expect(await rows()).toEqual([
        { id: "cli", name: "Original", category: "Member", secret: "kept" },
      ])
      succeeds(await run(["update", "/cli", "cli", "--input", "{}"]), {
        id: "cli",
        data: { id: "cli", name: "unchanged", detailOnly: "callback result" },
      })
      expect((await rows())[0]?.["name"]).toBe("Original")
      writeFileSync(join(root, "input.json"), '{"name":"From file"}')
      succeeds(
        await run([
          "update",
          "/cli",
          "cli",
          "--input-file",
          join(root, "input.json"),
        ]),
        {
          id: "cli",
          data: { id: "cli", name: "From file", detailOnly: "callback result" },
        },
      )
      expect((await rows())[0]?.["name"]).toBe("From file")
      succeeds(
        await run(["update", "/cli", "cli", "--input-stdin"], '{"name":null}'),
        { id: "cli", data: null },
      )
      expect((await rows())[0]?.["name"]).toBeNull()
      succeeds(await run(["delete", "/cli", "cli"]), { id: "cli", data: true })
      expect(await rows()).toEqual([
        { id: "cli", name: null, category: "Archived", secret: "kept" },
      ])
    } finally {
      mutationServer.stop(true)
      rmSync(root, { recursive: true, force: true })
    }
    expect(
      (await execute("{ __schema { queryType { name } } }")).data.__schema
        .queryType.name,
    ).toBe("Query")
  } finally {
    await runtime.dispose()
  }
  // Includes sequential CLI subprocesses sharing CPU with the parallel CI lanes.
}, 120_000)
