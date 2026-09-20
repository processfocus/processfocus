/**
 * Server-only Drizzle helpers for applying validated List sorting.
 *
 * Do not export this module from the root `@pf/process` entrypoint or import it
 * from frontend code. Frontend consumers need the ORM-free List contracts from
 * `@pf/process`; this sub-path intentionally carries the Drizzle dependency.
 */
import { type SQL, type SQLWrapper, asc, desc, sql } from "drizzle-orm"
import type { ListSortDirection, ListSortInput } from "./list"

export class ListQuerySortFieldNotFoundError extends Error {
  readonly field: string

  constructor(field: string) {
    super(`No SQL sort expression configured for list field "${field}"`)
    this.name = "ListQuerySortFieldNotFoundError"
    this.field = field
  }
}

export type ListQuerySortExpression = SQLWrapper

export interface ListQuerySortField {
  readonly _tag: "ListQuerySortField"
  /** Server-owned SQL expression or selected field used for this output field. */
  readonly expression: ListQuerySortExpression
  /** Fold string values with lower(...) before sorting. */
  readonly caseInsensitive?: boolean | undefined
}

export function listQuerySortField(
  expression: ListQuerySortExpression,
  options: { readonly caseInsensitive?: boolean } = {},
): ListQuerySortField {
  return {
    _tag: "ListQuerySortField",
    expression,
    caseInsensitive: options.caseInsensitive,
  }
}

export type ListQuerySortFields = Readonly<
  Record<string, ListQuerySortExpression | ListQuerySortField>
>

type ListQuerySelectedSortFieldName<TFields> = Extract<keyof TFields, string>

export interface ListQuerySelectedSortFieldsOptions<
  TField extends string = string,
> {
  /** Selected output fields that should not become sort expressions. */
  readonly exclude?: readonly TField[] | undefined
  /**
   * Selected output fields that should be folded with lower(...) before
   * sorting. Prefer explicit field names when the selection mixes text and
   * non-text fields. Use true only when every included selected field is
   * text-like.
   */
  readonly caseInsensitive?: boolean | readonly TField[] | undefined
}

export function listQuerySelectedSortFields<
  TFields extends Readonly<Record<string, ListQuerySortExpression>>,
>(
  fields: TFields,
  options: ListQuerySelectedSortFieldsOptions<
    ListQuerySelectedSortFieldName<TFields>
  > = {},
): ListQuerySortFields {
  const excludedFields = new Set<string>(options.exclude ?? [])
  for (const field of excludedFields) {
    if (!(field in fields)) {
      throw new ListQuerySortFieldNotFoundError(field)
    }
  }
  const caseInsensitiveFields = Array.isArray(options.caseInsensitive)
    ? new Set<string>(options.caseInsensitive)
    : undefined
  if (caseInsensitiveFields) {
    for (const field of caseInsensitiveFields) {
      if (!(field in fields)) {
        throw new ListQuerySortFieldNotFoundError(field)
      }
    }
  }

  return Object.fromEntries(
    Object.entries(fields)
      .filter(([field]) => !excludedFields.has(field))
      .map(([field, expression]) => {
        const caseInsensitive =
          options.caseInsensitive === true ||
          (caseInsensitiveFields?.has(field) ?? false)
        return [
          field,
          listQuerySortField(
            expression,
            caseInsensitive ? { caseInsensitive } : {},
          ),
        ]
      }),
  )
}

export interface ListQuerySortTieBreaker {
  readonly _tag: "ListQuerySortTieBreaker"
  readonly expression: ListQuerySortExpression
  readonly direction?: ListSortDirection | undefined
}

export function listQuerySortTieBreaker(
  expression: ListQuerySortExpression,
  options: { readonly direction?: ListSortDirection } = {},
): ListQuerySortTieBreaker {
  return {
    _tag: "ListQuerySortTieBreaker",
    expression,
    direction: options.direction,
  }
}

export interface ListQueryOrderByOptions {
  readonly sort?: ListSortInput | undefined
  readonly fields: ListQuerySortFields
  readonly defaultOrder: readonly SQL[]
  readonly tieBreaker?: ListQuerySortExpression | ListQuerySortTieBreaker
}

function normalizeListQuerySortField(
  field: ListQuerySortExpression | ListQuerySortField,
): ListQuerySortField {
  return isListQuerySortField(field) ? field : listQuerySortField(field)
}

function normalizeListQuerySortTieBreaker(
  tieBreaker: ListQueryOrderByOptions["tieBreaker"],
): ListQuerySortTieBreaker | undefined {
  if (tieBreaker === undefined) return undefined
  return isListQuerySortTieBreaker(tieBreaker)
    ? tieBreaker
    : listQuerySortTieBreaker(tieBreaker)
}

function isListQuerySortField(
  field: ListQuerySortExpression | ListQuerySortField,
): field is ListQuerySortField {
  return (
    typeof field === "object" &&
    field !== null &&
    "_tag" in field &&
    field._tag === "ListQuerySortField"
  )
}

function isListQuerySortTieBreaker(
  tieBreaker: ListQuerySortExpression | ListQuerySortTieBreaker,
): tieBreaker is ListQuerySortTieBreaker {
  return (
    typeof tieBreaker === "object" &&
    tieBreaker !== null &&
    "_tag" in tieBreaker &&
    tieBreaker._tag === "ListQuerySortTieBreaker"
  )
}

function listQuerySortValueExpression(field: ListQuerySortField): SQLWrapper {
  return field.caseInsensitive
    ? sql`nullif(lower(${field.expression}), '')`
    : field.expression
}

function listQuerySortExpression(
  field: ListQuerySortField,
  direction: ListSortDirection,
): SQL {
  const expression = listQuerySortValueExpression(field)
  return direction === "ASC"
    ? sql`${expression} asc nulls first`
    : sql`${expression} desc nulls last`
}

function listQueryTieBreakerExpression(tieBreaker: ListQuerySortTieBreaker) {
  return tieBreaker.direction === "DESC"
    ? desc(tieBreaker.expression)
    : asc(tieBreaker.expression)
}

/**
 * Build Drizzle order-by expressions for a standard List query.
 *
 * User-provided field names are only used to look up server-owned expressions,
 * never as SQL identifiers. Filtering should happen before these expressions
 * are applied, and pagination should happen after orderBy(...expressions).
 *
 * Missing field configuration is a programming error. The GraphQL resolver
 * validates user sort keys before query execution, so this throws as a defect
 * instead of returning a recoverable Effect error.
 */
export function listQueryOrderBy(options: ListQueryOrderByOptions): SQL[] {
  if (options.sort === undefined) {
    return [...options.defaultOrder]
  }

  const field = options.fields[options.sort.field]
  if (field === undefined) {
    throw new ListQuerySortFieldNotFoundError(options.sort.field)
  }

  const tieBreaker = normalizeListQuerySortTieBreaker(options.tieBreaker)
  return [
    listQuerySortExpression(
      normalizeListQuerySortField(field),
      options.sort.direction,
    ),
    ...(tieBreaker ? [listQueryTieBreakerExpression(tieBreaker)] : []),
  ]
}
