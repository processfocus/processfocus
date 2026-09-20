import { randomUUID } from "node:crypto"
import { Effect, Layer, Stream } from "effect"
import { AuthorizationService, ListRef } from "@pf/auth-policy"
import {
  type DocumentStoreError,
  DocumentStoreService,
  sanitizeDownloadFilename,
} from "@pf/document-store-service"
import {
  ExportNonScalarError,
  ExportRowLimitError,
  InputValidationError,
  ListNotFoundError,
} from "@pf/graphql-schema"
import {
  type ListQueryContext,
  type ListSortInput,
  OrganisationProvider,
  normalizePath,
} from "@pf/process"
import { buildPrincipal } from "./authorization"
import { rolePathsForList } from "./list-field-authorization"
import type { UserContext } from "./types"

const MAX_EXPORT_ROWS = 10_000

const EXPORT_STORE_PREFIX = "exports"

type ScalarValue = string | number | boolean | null

function isScalarValue(value: unknown): value is ScalarValue {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
}

function escapeCsvField(value: ScalarValue): string {
  if (value === null) return ""
  const str = String(value)
  if (
    str.includes(",") ||
    str.includes('"') ||
    str.includes("\n") ||
    str.includes("\r")
  ) {
    return `"${str.replace(/"/g, '""')}"`
  }
  return str
}

function generateCsv(
  fields: string[],
  items: readonly Record<string, unknown>[],
  listPath: string,
): Effect.Effect<string, ExportNonScalarError> {
  return Effect.gen(function* () {
    const header = fields.map(escapeCsvField).join(",")
    const rows: string[] = []

    for (const item of items) {
      const cells: string[] = []

      for (const field of fields) {
        const value = item[field] === undefined ? null : item[field]
        if (!isScalarValue(value)) {
          return yield* new ExportNonScalarError({
            listPath,
            field,
            valueType: typeof value,
          })
        }
        cells.push(escapeCsvField(value))
      }

      rows.push(cells.join(","))
    }

    return `${[header, ...rows].join("\r\n")}\r\n`
  })
}

function generateObjectKey(slugName: string): string {
  return `${slugName}-${randomUUID()}.csv`
}

function friendlyFilename(listName: string): string {
  return `${sanitizeDownloadFilename(listName)}.csv`
}

type ExportResult = {
  readonly downloadUrl: string
  readonly expiresAt: string
}

export type ListExportOptions = {
  readonly filter?: string | null
  readonly sort?: ListSortInput | null
}

type ExportError =
  | ListNotFoundError
  | ExportRowLimitError
  | ExportNonScalarError
  | InputValidationError
  | DocumentStoreError

const validateListSortInput = (
  sortableFields: ReadonlySet<string>,
  sort: ListSortInput | null | undefined,
): Effect.Effect<ListSortInput | undefined, InputValidationError> => {
  if (sort == null) {
    return Effect.succeed(undefined)
  }

  if (!sortableFields.has(sort.field)) {
    return Effect.fail(
      new InputValidationError({
        errors: [
          {
            field: "sort.field",
            message: `Unsupported list sort field "${sort.field}".`,
          },
        ],
      }),
    )
  }

  return Effect.succeed(sort)
}

export class ListExportService extends Effect.Tag(
  "@pf/graphql-api/ListExportService",
)<
  ListExportService,
  {
    readonly exportListCsv: (
      listPath: string,
      context: UserContext,
      options?: ListExportOptions,
    ) => Effect.Effect<ExportResult, ExportError, never>
  }
>() {}

export const ListExportServiceLive = Layer.effect(
  ListExportService,
  Effect.gen(function* () {
    const org = yield* OrganisationProvider
    const auth = yield* AuthorizationService
    const docStore = yield* DocumentStoreService

    return ListExportService.of({
      exportListCsv: (listPath, context, options) =>
        Effect.gen(function* () {
          const normalizedListPath = normalizePath(listPath)
          const allLists = org.organisation.lists()
          const list = allLists.find(
            (l) => l.normalizedPath() === normalizedListPath,
          )

          if (!list) {
            return yield* new ListNotFoundError({
              listPath: normalizedListPath,
            })
          }

          const principal = yield* buildPrincipal(context)
          const resource = new ListRef(
            list.normalizedPath(),
            rolePathsForList(list.roles),
          )
          const canAccess = yield* auth
            .canAccessList(principal, resource)
            .pipe(Effect.orElseSucceed(() => false))

          if (!canAccess) {
            return yield* new ListNotFoundError({
              listPath: normalizedListPath,
            })
          }

          // Export sort comes from the prepared List view, so validate against
          // the standard list columns that produced the user's sort state.
          const sortableFields = new Set(
            list
              .outputColumns()
              .filter((column) => column.sortable)
              .map((column) => column.field),
          )
          const sort = yield* validateListSortInput(
            sortableFields,
            options?.sort,
          )
          const filter = options?.filter ?? null
          const exportQueryContext: ListQueryContext = {
            page: 1,
            limit: MAX_EXPORT_ROWS + 1,
            ...(filter !== "" && filter !== null ? { filter } : {}),
            ...(sort !== undefined ? { sort } : {}),
          }

          const result: {
            readonly items: readonly Record<string, unknown>[]
            readonly totalCount: number
            // biome-ignore lint/suspicious/noExplicitAny: List class type erased at runtime
          } = yield* (list as any).executeExportQuery(exportQueryContext)

          if (result.items.length > MAX_EXPORT_ROWS) {
            return yield* new ExportRowLimitError({
              listPath: normalizedListPath,
              rowCount: result.totalCount,
              maxRows: MAX_EXPORT_ROWS,
            })
          }

          const fields = list.exportFieldNames()
          const csv = yield* generateCsv(
            fields,
            result.items,
            normalizedListPath,
          )

          const objectKey = generateObjectKey(list.slugName())
          const filename = friendlyFilename(list.name)
          const contentBytes = new TextEncoder().encode(csv)

          yield* docStore.storeFile({
            fileId: objectKey,
            storePrefix: EXPORT_STORE_PREFIX,
            content: Stream.succeed(contentBytes),
            contentType: "text/csv",
            filename,
          })

          return yield* docStore.requestDownloadUrl(
            objectKey,
            EXPORT_STORE_PREFIX,
            filename,
          )
        }) as Effect.Effect<ExportResult, ExportError, never>,
    })
  }),
)
