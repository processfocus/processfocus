import { DateTime, Effect, Either, Layer, Schema, Stream } from "effect"
import { AuthorizationService } from "@pf/auth-policy"
import { DocumentStoreService } from "@pf/document-store-service"
import {
  ExportNonScalarError,
  ExportRowLimitError,
  InputValidationError,
  ListNotFoundError,
} from "@pf/graphql-schema"
import {
  List,
  type ListQueryContext,
  ListVisibleInList,
  OrgUnit,
  Organisation,
  OrganisationProvider,
  Role,
} from "@pf/process"
import {
  ListExportService,
  ListExportServiceLive,
} from "../src/lib/list-export"
import type { UserContext } from "../src/lib/types"
import { describe, expect, it } from "bun:test"

const TEST_USER_EMAIL = "test@example.com"
const DEFAULT_LIST_PATH = "/operations/employees"

const makeContext = (): UserContext => ({
  _requestTime: DateTime.unsafeMake("2026-04-06T10:00:00.000Z"),
  _userDetails: {
    by: TEST_USER_EMAIL,
    id: TEST_USER_EMAIL,
  } as UserContext["_userDetails"],
  jwt: {
    mode: "access",
    type: "user",
    properties: {
      userId: TEST_USER_EMAIL,
      email: TEST_USER_EMAIL,
      roles: ["/operations/viewer"],
      orgUnitPath: "/operations",
      orgUnitId: "/operations",
    },
    aud: "graphql-api",
    iss: "http://localhost:4020",
    sub: TEST_USER_EMAIL,
    exp: 0,
    iat: 0,
  },
  userId: TEST_USER_EMAIL,
})

type StoredExportState = {
  storedFilename: string | undefined
  requestedFilename: string | undefined
  csv: string | undefined
}

function makeStoredExportState(): StoredExportState {
  return {
    storedFilename: undefined,
    requestedFilename: undefined,
    csv: undefined,
  }
}

function mergeChunks(chunks: Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const content = new Uint8Array(totalLength)
  let offset = 0

  for (const chunk of chunks) {
    content.set(chunk, offset)
    offset += chunk.length
  }

  return content
}

const makeAuthorizationService = (
  canAccess: boolean,
): AuthorizationService["Type"] => ({
  canIssueDelegationSecret: () => Effect.succeed(false),
  canListDelegationTokens: () => Effect.succeed(false),
  canManageDelegation: () => Effect.succeed(false),
  canLogin: () => Effect.succeed(false),
  canCompleteStep: () => Effect.succeed(false),
  canCompleteTodo: () => Effect.succeed(false),
  canCorrectPublicCompletionTodo: () => Effect.succeed(false),
  canCompletePublicTodo: () => Effect.succeed(false),
  canRequestRole: () => Effect.succeed(false),
  canRequestProviderUserPermissions: () => Effect.succeed(false),
  canActOnBehalfOf: () => Effect.succeed(false),
  canViewExecution: () => Effect.succeed(false),
  canRestartExecution: () => Effect.succeed(false),
  canAbandonStep: () => Effect.succeed(false),
  canDraftStep: () => Effect.succeed(false),
  canModifyField: () => Effect.succeed(false),
  canAccessField: () => Effect.succeed(false),
  canAccessFeature: () => Effect.succeed(false),
  canAccessList: () => Effect.succeed(canAccess),
  canCreateList: () => Effect.succeed(false),
  canUpdateList: () => Effect.succeed(false),
  canDeleteList: () => Effect.succeed(false),
  canDownloadFile: () => Effect.succeed(false),
  canDeleteFile: () => Effect.succeed(false),
  canPerformAction: () => Effect.succeed(false),
})

const makeDocumentStoreService = (
  state: StoredExportState,
): DocumentStoreService["Type"] => ({
  requestUploadUrl: () =>
    Effect.dieMessage("requestUploadUrl not used in tests"),
  requestDownloadUrl: (_fileId, _storePrefix, filename) => {
    state.requestedFilename = filename
    return Effect.succeed({
      downloadUrl: "https://example.com/exports/employees.csv",
      expiresAt: "2026-04-13T01:00:00.000Z",
    })
  },
  storeFile: (opts) =>
    Stream.runFold(opts.content, [] as Uint8Array[], (chunks, chunk) => {
      chunks.push(chunk)
      return chunks
    }).pipe(
      Effect.orDie,
      Effect.map((chunks) => {
        state.storedFilename = opts.filename
        state.csv = new TextDecoder().decode(mergeChunks(chunks))
        return { fileId: opts.fileId }
      }),
    ),
  getFileContent: () => Effect.dieMessage("getFileContent not used in tests"),
  getFileMetadata: () => Effect.dieMessage("getFileMetadata not used in tests"),
  deleteFile: () => Effect.dieMessage("deleteFile not used in tests"),
})

function makeExportLayer(
  organisation: Organisation,
  state: StoredExportState,
  canAccess = true,
) {
  return ListExportServiceLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(
          AuthorizationService,
          makeAuthorizationService(canAccess),
        ),
        Layer.succeed(DocumentStoreService, makeDocumentStoreService(state)),
        Layer.succeed(OrganisationProvider, {
          organisation,
          orgPath: "/tmp/org",
          schemaPath: "/tmp/org.graphql",
        }),
      ),
    ),
  )
}

async function runExport(
  organisation: Organisation,
  state: StoredExportState,
  options?: {
    listPath?: string
    canAccess?: boolean
    filter?: string | null
    sort?: { readonly field: string; readonly direction: "ASC" | "DESC" } | null
  },
) {
  const resolvedOptions = options ?? {}

  const effect = Effect.gen(function* () {
    const service = yield* ListExportService
    return yield* service.exportListCsv(
      resolvedOptions.listPath ?? DEFAULT_LIST_PATH,
      makeContext(),
      {
        ...(resolvedOptions.filter !== undefined
          ? { filter: resolvedOptions.filter }
          : {}),
        ...(resolvedOptions.sort !== undefined
          ? { sort: resolvedOptions.sort }
          : {}),
      },
    )
  }).pipe(
    Effect.provide(
      makeExportLayer(organisation, state, resolvedOptions.canAccess ?? true),
    ),
  )

  return Effect.runPromise(Effect.either(effect))
}

type ExportOutcome = Awaited<ReturnType<typeof runExport>>

function expectRight(result: ExportOutcome) {
  expect(Either.isRight(result)).toBe(true)
  if (Either.isLeft(result)) {
    throw result.left
  }
  return result.right
}

function expectLeft(result: ExportOutcome) {
  expect(Either.isLeft(result)).toBe(true)
  if (Either.isRight(result)) {
    throw result.right
  }
  return result.left
}

describe("ListExportService", () => {
  it("stores escaped CSV content and sanitizes the download filename", async () => {
    const organisation = new Organisation({ name: "Test Organisation" })
    const operations = new OrgUnit(organisation, "operations", {
      name: "Operations",
      type: "department",
    })
    const viewer = new Role(operations, "viewer", { name: "Viewer" })

    new List(operations, "employees", {
      name: 'Employee "Records"',
      roles: [viewer],
      output: {
        "last,name": Schema.String,
        notes: Schema.String,
      },
      query: () =>
        Effect.succeed({
          items: [
            {
              "last,name": 'Smith, "Jane"',
              notes: "line1\rline2",
            },
          ],
          totalCount: 1,
        }),
    })

    const state = makeStoredExportState()
    const result = expectRight(await runExport(organisation, state))

    expect(result.downloadUrl).toBe("https://example.com/exports/employees.csv")
    expect(state.storedFilename).toBe("Employee 'Records'.csv")
    expect(state.requestedFilename).toBe("Employee 'Records'.csv")
    expect(state.csv).toBe(
      '"last,name",notes\r\n"Smith, ""Jane""","line1\rline2"\r\n',
    )
  })

  it("returns ListNotFoundError when the caller cannot access the list", async () => {
    const organisation = new Organisation({ name: "Test Organisation" })
    const operations = new OrgUnit(organisation, "operations", {
      name: "Operations",
      type: "department",
    })
    const viewer = new Role(operations, "viewer", { name: "Viewer" })

    new List(operations, "employees", {
      name: "Employees",
      roles: [viewer],
      output: { id: Schema.String },
      query: () => Effect.succeed({ items: [], totalCount: 0 }),
    })

    const error = expectLeft(
      await runExport(organisation, makeStoredExportState(), {
        canAccess: false,
      }),
    )

    expect(error._tag).toBe("ListNotFoundError")
    expect(error).toBeInstanceOf(ListNotFoundError)
    if (error._tag !== "ListNotFoundError") {
      throw error
    }
    expect(error.listPath).toBe("/operations/employees")
  })

  it("returns ListNotFoundError when the list path does not exist", async () => {
    const organisation = new Organisation({ name: "Test Organisation" })
    const operations = new OrgUnit(organisation, "operations", {
      name: "Operations",
      type: "department",
    })
    const viewer = new Role(operations, "viewer", { name: "Viewer" })

    new List(operations, "employees", {
      name: "Employees",
      roles: [viewer],
      output: { id: Schema.String },
      query: () => Effect.succeed({ items: [], totalCount: 0 }),
    })

    const error = expectLeft(
      await runExport(organisation, makeStoredExportState(), {
        listPath: "/operations/missing",
      }),
    )

    expect(error._tag).toBe("ListNotFoundError")
    expect(error).toBeInstanceOf(ListNotFoundError)
    if (error._tag !== "ListNotFoundError") {
      throw error
    }
    expect(error.listPath).toBe("/operations/missing")
  })

  it("returns ExportNonScalarError through the typed error channel", async () => {
    const organisation = new Organisation({ name: "Test Organisation" })
    const operations = new OrgUnit(organisation, "operations", {
      name: "Operations",
      type: "department",
    })
    const viewer = new Role(operations, "viewer", { name: "Viewer" })

    new List(operations, "employees", {
      name: "Employees",
      roles: [viewer],
      output: {
        id: Schema.String,
        metadata: Schema.String,
      },
      query: () =>
        Effect.succeed({
          items: [
            {
              id: "1",
              metadata: { nested: true } as unknown as string,
            },
          ],
          totalCount: 1,
        }),
    })

    const error = expectLeft(
      await runExport(organisation, makeStoredExportState()),
    )

    expect(error._tag).toBe("ExportNonScalarError")
    expect(error).toBeInstanceOf(ExportNonScalarError)
    if (error._tag !== "ExportNonScalarError") {
      throw error
    }
    expect(error.field).toBe("metadata")
    expect(error.valueType).toBe("object")
  })

  it("treats missing fields as empty CSV cells", async () => {
    const organisation = new Organisation({ name: "Test Organisation" })
    const operations = new OrgUnit(organisation, "operations", {
      name: "Operations",
      type: "department",
    })
    const viewer = new Role(operations, "viewer", { name: "Viewer" })

    new List(operations, "employees", {
      name: "Employees",
      roles: [viewer],
      output: {
        id: Schema.String,
        name: Schema.String,
      },
      query: () =>
        Effect.succeed({
          items: [{ id: "1" } as unknown as { id: string; name: string }],
          totalCount: 1,
        }),
    })

    const state = makeStoredExportState()
    expectRight(await runExport(organisation, state))

    expect(state.csv).toBe("id,name\r\n1,\r\n")
  })

  it("falls back to the normal list query and output when no export overrides exist", async () => {
    const organisation = new Organisation({ name: "Test Organisation" })
    const operations = new OrgUnit(organisation, "operations", {
      name: "Operations",
      type: "department",
    })
    const viewer = new Role(operations, "viewer", { name: "Viewer" })

    new List(operations, "employees", {
      name: "Employees",
      roles: [viewer],
      output: {
        id: Schema.String,
        name: Schema.String,
      },
      query: () =>
        Effect.succeed({
          items: [{ id: "1", name: "Jane" }],
          totalCount: 1,
        }),
    })

    const state = makeStoredExportState()
    expectRight(await runExport(organisation, state))

    expect(state.csv).toBe("id,name\r\n1,Jane\r\n")
  })

  it("passes validated sort state to the export query", async () => {
    const organisation = new Organisation({ name: "Test Organisation" })
    const operations = new OrgUnit(organisation, "operations", {
      name: "Operations",
      type: "department",
    })
    const viewer = new Role(operations, "viewer", { name: "Viewer" })
    let receivedContext: ListQueryContext | undefined

    new List(operations, "employees", {
      name: "Employees",
      roles: [viewer],
      output: {
        id: Schema.String,
        name: Schema.String,
      },
      query: (ctx) => {
        receivedContext = ctx
        const items = [
          { id: "2", name: "Zoe" },
          { id: "1", name: "Ada" },
        ].toSorted((a, b) =>
          ctx.sort?.direction === "DESC"
            ? b.name.localeCompare(a.name)
            : a.name.localeCompare(b.name),
        )
        return Effect.succeed({ items, totalCount: items.length })
      },
    })

    const state = makeStoredExportState()
    expectRight(
      await runExport(organisation, state, {
        sort: { field: "name", direction: "ASC" },
      }),
    )

    expect(receivedContext).toEqual({
      page: 1,
      limit: 10_001,
      sort: { field: "name", direction: "ASC" },
    })
    expect(state.csv).toBe("id,name\r\n1,Ada\r\n2,Zoe\r\n")
  })

  it("passes filter and sort state while ignoring the current page", async () => {
    const organisation = new Organisation({ name: "Test Organisation" })
    const operations = new OrgUnit(organisation, "operations", {
      name: "Operations",
      type: "department",
    })
    const viewer = new Role(operations, "viewer", { name: "Viewer" })
    const rows = [
      { id: "1", name: "Ada", department: "Engineering" },
      { id: "2", name: "Jane", department: "Sales" },
      { id: "3", name: "Zoe", department: "Engineering" },
    ]

    new List(operations, "employees", {
      name: "Employees",
      roles: [viewer],
      output: {
        id: Schema.String,
        name: Schema.String,
        department: Schema.String,
      },
      query: (ctx) => {
        expect(ctx.page).toBe(1)
        expect(ctx.limit).toBe(10_001)
        const filtered = rows.filter((row) =>
          row.department.toLowerCase().includes(ctx.filter ?? ""),
        )
        const sorted = filtered.toSorted((a, b) =>
          ctx.sort?.direction === "DESC"
            ? b.name.localeCompare(a.name)
            : a.name.localeCompare(b.name),
        )
        return Effect.succeed({
          items: sorted,
          totalCount: sorted.length,
        })
      },
    })

    const state = makeStoredExportState()
    expectRight(
      await runExport(organisation, state, {
        filter: "engineering",
        sort: { field: "name", direction: "DESC" },
      }),
    )

    expect(state.csv).toBe(
      "id,name,department\r\n3,Zoe,Engineering\r\n1,Ada,Engineering\r\n",
    )
  })

  it("rejects invalid export sort keys before executing the export query", async () => {
    const organisation = new Organisation({ name: "Test Organisation" })
    const operations = new OrgUnit(organisation, "operations", {
      name: "Operations",
      type: "department",
    })
    const viewer = new Role(operations, "viewer", { name: "Viewer" })
    let queryExecuted = false

    new List(operations, "employees", {
      name: "Employees",
      roles: [viewer],
      output: {
        id: Schema.String,
        hiddenCode: Schema.String.annotations({
          [ListVisibleInList]: false,
        }),
      },
      query: () => {
        queryExecuted = true
        return Effect.succeed({ items: [], totalCount: 0 })
      },
    })

    const error = expectLeft(
      await runExport(organisation, makeStoredExportState(), {
        sort: { field: "hiddenCode", direction: "ASC" },
      }),
    )

    expect(error._tag).toBe("InputValidationError")
    expect(error).toBeInstanceOf(InputValidationError)
    expect(error.message).toContain("sort.field")
    expect(queryExecuted).toBe(false)
  })

  it("uses export-specific schema and query when configured", async () => {
    const organisation = new Organisation({ name: "Test Organisation" })
    const operations = new OrgUnit(organisation, "operations", {
      name: "Operations",
      type: "department",
    })
    const viewer = new Role(operations, "viewer", { name: "Viewer" })

    new List(operations, "employees", {
      name: "Employees",
      roles: [viewer],
      output: {
        id: Schema.String,
        name: Schema.String,
      },
      exportOutput: {
        id: Schema.String,
        email: Schema.String,
      },
      query: () =>
        Effect.succeed({
          items: [{ id: "1", name: "Jane" }],
          totalCount: 1,
        }),
      exportQuery: () =>
        Effect.succeed({
          items: [{ id: "1", email: "jane@example.com" }],
          totalCount: 1,
        }),
    })

    const state = makeStoredExportState()
    expectRight(await runExport(organisation, state))

    expect(state.csv).toBe("id,email\r\n1,jane@example.com\r\n")
  })

  it("exports a zero-row list as a header-only CSV", async () => {
    const organisation = new Organisation({ name: "Test Organisation" })
    const operations = new OrgUnit(organisation, "operations", {
      name: "Operations",
      type: "department",
    })
    const viewer = new Role(operations, "viewer", { name: "Viewer" })

    new List(operations, "employees", {
      name: "Employees",
      roles: [viewer],
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

    const state = makeStoredExportState()
    expectRight(await runExport(organisation, state))

    expect(state.csv).toBe("id,name\r\n")
  })

  it("allows scalar unions in the effective export schema", () => {
    const organisation = new Organisation({ name: "Test Organisation" })
    const operations = new OrgUnit(organisation, "operations", {
      name: "Operations",
      type: "department",
    })
    const viewer = new Role(operations, "viewer", { name: "Viewer" })

    expect(
      () =>
        new List(operations, "employees", {
          name: "Employees",
          roles: [viewer],
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

  it("fails when the export exceeds the 10,000 row limit", async () => {
    const organisation = new Organisation({ name: "Test Organisation" })
    const operations = new OrgUnit(organisation, "operations", {
      name: "Operations",
      type: "department",
    })
    const viewer = new Role(operations, "viewer", { name: "Viewer" })

    new List(operations, "employees", {
      name: "Employees",
      roles: [viewer],
      output: { id: Schema.String },
      query: () =>
        Effect.succeed({
          items: Array.from({ length: 10_001 }, (_, index) => ({
            id: String(index + 1),
          })),
          totalCount: 10_001,
        }),
    })

    const error = expectLeft(
      await runExport(organisation, makeStoredExportState()),
    )

    expect(error._tag).toBe("ExportRowLimitError")
    expect(error).toBeInstanceOf(ExportRowLimitError)
    if (error._tag !== "ExportRowLimitError") {
      throw error
    }
    expect(error.rowCount).toBe(10_001)
    expect(error.maxRows).toBe(10_000)
  })
})
