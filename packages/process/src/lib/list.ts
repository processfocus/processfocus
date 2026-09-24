import { Construct } from "constructs"
import type { Schema } from "effect"
import {
  Data,
  type Effect,
  Effect as EffectModule,
  String as EffectString,
  JSONSchema,
  Option,
  SchemaAST,
  Schema as SchemaModule,
} from "effect"
import type { JsonSchema7Root } from "effect/JSONSchema"
import {
  type ClientFormDefinition,
  type WalkError,
  asClientRepresentation,
} from "@pf/form-client-representation"
import {
  METRIC_BREAKDOWN_SYMBOL,
  type MetricBreakdownControl,
  isMetricBreakdownOptions,
  isReadOnlyField,
} from "@pf/form-schema"
import {
  type DeepWritable,
  type FlattenFields,
  getSchemaDefaults,
  submissionSchemaSync as makeSubmissionSchema,
} from "@pf/form-submission-schema"
import { isForm } from "./brands"
import { mergeFormDefaults, resolveFormFieldDefaults } from "./form-defaults"
import type { OrgUnit } from "./org-unit"
import { normalizePath, pathToPascalCase } from "./org-utils"
import type { Process } from "./process"
import type { Role } from "./role"

/**
 * Error thrown when executeItemQuery is called on a List without an itemQuery defined.
 */
export class ListItemQueryNotDefinedError extends Data.TaggedError(
  "ListItemQueryNotDefinedError",
)<{
  readonly listPath: string
}> {
  override get message() {
    return `List ${this.listPath} has no itemQuery defined`
  }
}

/**
 * Error thrown when executeUpdate is called on a List without an update function defined.
 */
export class ListItemUpdateNotDefinedError extends Data.TaggedError(
  "ListItemUpdateNotDefinedError",
)<{
  readonly listPath: string
}> {
  override get message() {
    return `List ${this.listPath} has no update function defined`
  }
}

/**
 * Error thrown when executeDelete is called on a List without a delete function defined.
 */
export class ListItemDeleteNotDefinedError extends Data.TaggedError(
  "ListItemDeleteNotDefinedError",
)<{
  readonly listPath: string
}> {
  override get message() {
    return `List ${this.listPath} has no delete function defined`
  }
}

/**
 * Client-safe creation failure. Use an empty field for a form-level persistence error.
 */
export class ListCreateError extends Data.TaggedError("ListCreateError")<{
  readonly field: string
  readonly message: string
}> {}

export class ListCreateNotDefinedError extends Data.TaggedError(
  "ListCreateNotDefinedError",
)<{
  readonly listPath: string
}> {}

/** Client-safe field validation error returned by a List update callback. */
export class ListUpdateValidationError extends Data.TaggedError(
  "ListUpdateValidationError",
)<{
  readonly field: string
  readonly message: string
}> {}

/**
 * Column metadata for list output fields.
 */
export const ListVisibleInList = Symbol.for("pf/list/annotation/VisibleInList")
/**
 * Optional sortability override for list output fields. This can opt hidden
 * fields into API-level sorting, for example internal timestamps that should
 * order rows without being displayed as columns.
 */
export const ListSortable = Symbol.for("pf/list/annotation/Sortable")

export interface ListColumn {
  /** Field name (used in GraphQL query) */
  readonly field: string
  /** Display label (from title annotation or capitalized field name) */
  readonly label: string
  /** Optional field description from schema annotations */
  readonly description?: string
  /** Whether this field should be shown in the generic list table */
  readonly visibleInList: boolean
  /** Whether this field can be used as a standard list sort key */
  readonly sortable: boolean
}

const defaultSchemaDescriptions = new Set(["a string", "a number", "a boolean"])

// Sortability is not the same scalar contract as CSV export: null-only fields
// are not meaningful sort keys, and transformations sort by encoded scalars
// only when the decoded form is not object-like.
function isObjectLikeListColumnAst(ast: SchemaAST.AST): boolean {
  switch (ast._tag) {
    case "TypeLiteral":
    case "TupleType":
      return true
    case "Refinement":
      return isObjectLikeListColumnAst(ast.from)
    case "Transformation":
      // Object-like decoded forms are not transparent scalar sort keys, even
      // when the encoded input side is scalar.
      return isObjectLikeListColumnAst(ast.to)
    case "Union":
      return ast.types.some((type) => isObjectLikeListColumnAst(type))
    default:
      return false
  }
}

function isScalarListColumnAst(ast: SchemaAST.AST): boolean {
  switch (ast._tag) {
    case "StringKeyword":
    case "NumberKeyword":
    case "BooleanKeyword":
      return true
    case "Literal":
      return (
        typeof ast.literal === "string" ||
        typeof ast.literal === "number" ||
        typeof ast.literal === "boolean"
      )
    case "Refinement":
      return isScalarListColumnAst(ast.from)
    case "Transformation":
      // Transformed fields sort by their encoded scalar representation, but
      // transforms that decode into objects or arrays are not sortable by default.
      return (
        isScalarListColumnAst(ast.from) && !isObjectLikeListColumnAst(ast.to)
      )
    case "Union": {
      const sortableMembers = ast.types.filter(
        (type) =>
          !(type._tag === "Literal" && type.literal === null) &&
          type._tag !== "UndefinedKeyword" &&
          type._tag !== "VoidKeyword",
      )
      return (
        sortableMembers.length > 0 &&
        sortableMembers.every((member) => isScalarListColumnAst(member))
      )
    }
    default:
      return false
  }
}

function toListColumn(
  field: string,
  schema: Schema.Schema.AnyNoContext,
  options?: { readonly sortable?: boolean },
): ListColumn {
  const titleAnnotation = schema.ast.annotations[SchemaAST.TitleAnnotationId]
  const label =
    typeof titleAnnotation === "string"
      ? titleAnnotation
      : EffectString.capitalize(field)
  const visibleInList = schema.ast.annotations[ListVisibleInList] !== false
  const sortableAnnotation = schema.ast.annotations[ListSortable]
  const sortable =
    options?.sortable ??
    (typeof sortableAnnotation === "boolean"
      ? sortableAnnotation
      : visibleInList && isScalarListColumnAst(schema.ast))
  const descriptionAnnotation =
    schema.ast.annotations[SchemaAST.DescriptionAnnotationId]
  const description =
    typeof descriptionAnnotation === "string" &&
    !defaultSchemaDescriptions.has(descriptionAnnotation)
      ? descriptionAnnotation
      : undefined

  return description === undefined
    ? { field, label, visibleInList, sortable }
    : { field, label, description, visibleInList, sortable }
}

/**
 * Result type for list queries with pagination info.
 */
export interface ListQueryResult<TItem> {
  /** Array of items for current page */
  readonly items: readonly TItem[]
  /** Total number of items matching the query (for pagination) */
  readonly totalCount: number
}

export type ListSortDirection = "ASC" | "DESC"

export interface ListSortInput {
  /** Output field to sort by */
  readonly field: string
  /** Explicit sort direction */
  readonly direction: ListSortDirection
}

/**
 * Context passed to the list query function.
 */
export interface ListQueryContext {
  /** Current page number (1-indexed) */
  readonly page: number
  /** Number of items per page */
  readonly limit: number
  /** Optional filter text to search across all columns */
  readonly filter?: string
  /** Optional standard sort request validated by the GraphQL resolver */
  readonly sort?: ListSortInput
}

/**
 * Context passed to the list item query function.
 */
export interface ListItemQueryContext {
  /** Selected generic control values, keyed by declared control name. */
  readonly controls?: Readonly<Record<string, string>>
}

type ListExportOutputFields<
  TOutput extends Schema.Struct.Fields,
  TExportOutput extends Schema.Struct.Fields | undefined,
> = TExportOutput extends Schema.Struct.Fields ? TExportOutput : TOutput

/**
 * Type to extract output item type from output schema fields.
 */
export type OutputItem<TOutput extends Schema.Struct.Fields> =
  Schema.Schema.Type<Schema.Struct<TOutput>>

/**
 * Function type for list queries.
 * TItem is the output type inferred from the output schema.
 */
export type ListQueryFunction<
  TOutput extends Schema.Struct.Fields,
  R = never,
> = (
  ctx: ListQueryContext,
) => Effect.Effect<ListQueryResult<OutputItem<TOutput>>, never, R>

/**
 * Function type for fetching a single list item by ID.
 * Returns the item or null if not found.
 */
export type ListItemQueryFunction<
  TForm extends Schema.Struct.Fields,
  R = never,
> = (
  id: string,
  ctx?: ListItemQueryContext,
) => Effect.Effect<OutputItem<TForm> | null, never, R>

const collectMetricBreakdownControlsFromAst = (
  ast: SchemaAST.AST,
): readonly MetricBreakdownControl[] => {
  const metricAnnotation = SchemaAST.getAnnotation(ast, METRIC_BREAKDOWN_SYMBOL)
  const metricOptions = Option.getOrUndefined(metricAnnotation)

  const ownControls =
    isMetricBreakdownOptions(metricOptions) &&
    metricOptions.dataSource === "item"
      ? (metricOptions.controls ?? [])
      : []

  switch (ast._tag) {
    case "TypeLiteral":
      return [
        ...ownControls,
        ...ast.propertySignatures.flatMap((property) =>
          collectMetricBreakdownControlsFromAst(property.type),
        ),
      ]
    case "Refinement":
      return [
        ...ownControls,
        ...collectMetricBreakdownControlsFromAst(ast.from),
      ]
    case "Transformation":
      return [...ownControls, ...collectMetricBreakdownControlsFromAst(ast.to)]
    case "Union":
      return [
        ...ownControls,
        ...ast.types.flatMap((type) =>
          collectMetricBreakdownControlsFromAst(type),
        ),
      ]
    default:
      return ownControls
  }
}

/**
 * Type for the update input, flattening wrapper fields and excluding
 * structural/read-only elements.
 */
type ListUpdateInput<TForm extends Schema.Struct.Fields> =
  FlattenFields<TForm> extends infer F extends Schema.Struct.Fields
    ? { [K in keyof F]: Schema.Schema.Type<F[K]> }
    : never

/** Decoded create input, preserving optional keys and excluding read-only fields. */
export type ListCreateInput<TForm extends Schema.Struct.Fields> =
  Schema.Schema.Type<ReturnType<typeof makeSubmissionSchema<TForm>>>

/**
 * Function type for updating a single list item by ID.
 * Returns the updated item or null if not found.
 * May fail with ListUpdateValidationError for server-side validation.
 */
export type ListUpdateFunction<
  TForm extends Schema.Struct.Fields,
  R = never,
> = (
  id: string,
  input: ListUpdateInput<TForm>,
) => Effect.Effect<OutputItem<TForm> | null, ListUpdateValidationError, R>

/**
 * Function type for deleting a single list item by ID.
 * Returns void on success. Errors are handled via the Effect error channel.
 */
export type ListDeleteFunction<R = never> = (
  id: string,
) => Effect.Effect<void, never, R>

/**
 * Props for creating a List construct.
 */
export interface ListProps<
  TOutput extends Schema.Struct.Fields,
  R = never,
  TForm extends Schema.Struct.Fields = Schema.Struct.Fields,
  TExportOutput extends Schema.Struct.Fields | undefined = undefined,
  TCreate extends Schema.Struct.Fields = Schema.Struct.Fields,
> {
  /** Display name for the list */
  readonly name: string
  /** Optional display name for a single list item detail view */
  readonly detailName?: string
  /** Optional description of what this list shows */
  readonly purpose?: string
  /** Roles allowed to access this list. Must not be empty. */
  readonly roles: readonly [Role, ...Role[]]
  /** Output schema defining the shape of list items `query` should return */
  readonly output: TOutput
  /** Optional button opening this process's single start form. Uses its start permission. */
  readonly startProcess?: Process
  /** Default page size (default: 20, max: 100) */
  readonly defaultPageSize?: number
  /** Query function returning paginated results */
  readonly query: ListQueryFunction<TOutput, R>
  /** Optional export schema overriding the normal list output for CSV exports */
  readonly exportOutput?: TExportOutput
  /** Optional export query overriding the normal list query for CSV exports */
  readonly exportQuery?: ListQueryFunction<
    ListExportOutputFields<TOutput, TExportOutput>,
    R
  >
  /** Optional form schema defining detail view fields (can differ from output) */
  readonly form?: () => TForm
  /** Optional query function for fetching a single item by ID */
  readonly itemQuery?: ListItemQueryFunction<TForm, R>
  /** Optional update function for updating a single item by ID */
  readonly update?: ListUpdateFunction<TForm, R>
  /** Optional delete function for deleting a single item by ID */
  readonly delete?: ListDeleteFunction<R>
  /** Opt-in creation, with an independent form and server-owned record ID. */
  readonly create?: {
    readonly form: () => TCreate
    readonly submit: (
      input: ListCreateInput<TCreate>,
    ) => Effect.Effect<string, ListCreateError, R>
  }
}

/**
 * Default page size for lists.
 */
export const DEFAULT_PAGE_SIZE = 20

/**
 * Maximum allowed page size for lists.
 */
export const MAX_PAGE_SIZE = 100

function isScalarExportAst(ast: SchemaAST.AST): boolean {
  switch (ast._tag) {
    case "StringKeyword":
    case "NumberKeyword":
    case "BooleanKeyword":
      return true
    case "Literal":
      return (
        ast.literal === null ||
        typeof ast.literal === "string" ||
        typeof ast.literal === "number" ||
        typeof ast.literal === "boolean"
      )
    case "Refinement":
      return isScalarExportAst(ast.from)
    case "Transformation":
      return isScalarExportAst(ast.to)
    case "Union": {
      const allowedMembers = ast.types.filter(
        (type) =>
          !(type._tag === "Literal" && type.literal === null) &&
          type._tag !== "UndefinedKeyword" &&
          type._tag !== "VoidKeyword",
      )
      return (
        allowedMembers.length > 0 &&
        allowedMembers.every((member) => isScalarExportAst(member))
      )
    }
    default:
      return false
  }
}

function assertScalarExportFields(
  listPath: string,
  fields: Schema.Struct.Fields,
): void {
  for (const [field, schema] of Object.entries(fields)) {
    if (!isScalarExportAst((schema as Schema.Schema.AnyNoContext).ast)) {
      throw new Error(
        `List ${normalizePath(listPath)} export field "${field}" must be a flat scalar value (string, number, boolean, or null)`,
      )
    }
  }
}

function assertExportFieldsHaveQuery(
  listPath: string,
  output: Schema.Struct.Fields,
  exportOutput: Schema.Struct.Fields | undefined,
  hasExportQuery: boolean,
): void {
  if (!exportOutput || hasExportQuery) {
    return
  }

  for (const field of Object.keys(exportOutput)) {
    if (!(field in output)) {
      throw new Error(
        `List ${normalizePath(listPath)} export field "${field}" requires exportQuery because it is not part of the normal list output`,
      )
    }
  }
}

/**
 * List construct for defining paginated data queries.
 *
 * Lists are organizational-level data views that can be accessed
 * based on role authorization. They define:
 * - Output schema for type-safe item structure
 * - Optional filter definitions
 * - A query function that returns paginated results
 *
 * @example
 * ```typescript
 * const employeesList = new List(schoolUnit, "employees", {
 *   name: "Example Employees",
 *   purpose: "View all school employees",
 *   roles: [adminRole],
 *   output: {
 *     id: ES.String,
 *     name: ES.String,
 *     staffNumber: ES.String,
 *     hireDate: DateTimeUtcSchema,
 *   },
 *   query: (ctx) => Effect.gen(function* () {
 *     const ops = yield* SchoolOperations
 *     return yield* ops.queryEmployees(ctx)
 *   }),
 * })
 * ```
 */
export class List<
  TOutput extends Schema.Struct.Fields = Schema.Struct.Fields,
  R = never,
  TId extends string = string,
  TForm extends Schema.Struct.Fields = Schema.Struct.Fields,
  TExportOutput extends Schema.Struct.Fields | undefined = undefined,
  TCreate extends Schema.Struct.Fields = Schema.Struct.Fields,
> extends Construct {
  readonly isList = true

  private readonly _create?: ListProps<
    TOutput,
    R,
    TForm,
    TExportOutput,
    TCreate
  >["create"]
  readonly createFormFields: TCreate | undefined

  /** Display name for the list */
  readonly name: string
  /** Optional display name for a single list item detail view */
  readonly detailName?: string

  /** Optional description of what this list shows */
  readonly purpose?: string

  /** Roles allowed to access this list */
  readonly roles: readonly [Role, ...Role[]]

  /** Output schema defining the shape of list items */
  readonly output: TOutput

  /** Start button metadata; visibility is authorized separately from List access. */
  readonly startProcess:
    | {
        readonly path: string
        readonly name: string
        readonly startStepPath: string
      }
    | undefined

  /** Default page size */
  readonly defaultPageSize: number

  /** The query function */
  private readonly _query: ListQueryFunction<TOutput, R>

  /** Effective export schema fields */
  private readonly _exportOutput: ListExportOutputFields<TOutput, TExportOutput>

  /** Optional export query override */
  private readonly _exportQuery:
    | ListQueryFunction<ListExportOutputFields<TOutput, TExportOutput>, R>
    | undefined

  /** Form schema function (optional) */
  private readonly _form?: () => TForm

  /** Cached form fields from calling _form() at construction */
  private readonly _formFields?: TForm

  /** Item query function (optional) */
  private readonly _itemQuery?: ListItemQueryFunction<TForm, R>

  /** Update function (optional) */
  private readonly _update?: ListUpdateFunction<TForm, R>

  /** Delete function (optional) */
  private readonly _delete?: ListDeleteFunction<R>

  /**
   * Create a List construct.
   *
   * @param scope - Parent OrgUnit
   * @param id - Unique identifier for this list within the OrgUnit
   * @param props - List configuration
   */
  constructor(
    scope: OrgUnit,
    id: TId,
    props: ListProps<TOutput, R, TForm, TExportOutput, TCreate>,
  ) {
    super(scope, id)
    this._create = props.create
    this.createFormFields = props.create?.form()
    if (
      this.createFormFields &&
      Object.keys(
        makeSubmissionSchema(SchemaModule.Struct(this.createFormFields)).fields,
      ).length === 0
    ) {
      throw new Error(
        `List ${normalizePath(this.node.path)} create form requires at least one submittable field`,
      )
    }
    if (props.startProcess) {
      const starts = props.startProcess.startNodes()
      const start = starts[0]
      if (starts.length !== 1 || !isForm(start)) {
        throw new Error(
          `List ${normalizePath(this.node.path)} startProcess must have exactly one start form`,
        )
      }
      this.startProcess = {
        path: normalizePath(props.startProcess.node.path),
        name: props.startProcess.props.name,
        startStepPath: normalizePath(start.node.path),
      }
    }
    this.name = props.name
    if (props.detailName !== undefined) {
      this.detailName = props.detailName
    }
    if (props.purpose !== undefined) {
      this.purpose = props.purpose
    }
    if (props.roles.length === 0) {
      throw new Error(
        `List ${normalizePath(this.node.path)} requires at least one role`,
      )
    }
    this.roles = props.roles
    this.output = props.output
    this.defaultPageSize = Math.min(
      props.defaultPageSize ?? DEFAULT_PAGE_SIZE,
      MAX_PAGE_SIZE,
    )
    this._query = props.query
    if (props.exportOutput) {
      assertScalarExportFields(this.node.path, props.exportOutput)
    }
    assertExportFieldsHaveQuery(
      this.node.path,
      props.output,
      props.exportOutput,
      props.exportQuery !== undefined,
    )
    this._exportOutput = (props.exportOutput ??
      props.output) as ListExportOutputFields<TOutput, TExportOutput>
    this._exportQuery = props.exportQuery

    // Store form and itemQuery if provided
    if (props.form) {
      this._form = props.form
      this._formFields = props.form()
    }
    if (props.itemQuery) {
      this._itemQuery = props.itemQuery
    }
    if (props.update) {
      this._update = props.update
    }
    if (props.delete) {
      this._delete = props.delete
    }
  }

  get hasCreate(): boolean {
    return this._create !== undefined
  }

  createMutationName(): string {
    return `createListItem${pathToPascalCase(this.node.path)}`
  }

  createInputTypeName(): string {
    return `Create${pathToPascalCase(this.node.path)}`
  }

  createSubmissionSchema(): ReturnType<
    typeof makeSubmissionSchema<TCreate>
  > | null {
    return this.createFormFields
      ? makeSubmissionSchema(SchemaModule.Struct(this.createFormFields))
      : null
  }

  createFormMetadata(currentProviderUser?: string): EffectModule.Effect<
    {
      readonly formDefinition: ClientFormDefinition
      readonly defaultValues: Record<string, DeepWritable<unknown>>
      readonly jsonSchema: JsonSchema7Root
      readonly createMutationName: string
      readonly createInputTypeName: string
    } | null,
    WalkError
  > {
    if (!this.createFormFields) return EffectModule.succeed(null)
    const fields = this.createFormFields
    const submission = makeSubmissionSchema(SchemaModule.Struct(fields))
    const createMutationName = this.createMutationName()
    const createInputTypeName = this.createInputTypeName()
    return EffectModule.gen(function* () {
      const components = yield* asClientRepresentation(
        SchemaModule.Struct(fields),
      )
      const defaults = yield* resolveFormFieldDefaults(
        fields,
        currentProviderUser,
      )
      return {
        formDefinition: { components, rules: [] },
        defaultValues: mergeFormDefaults(getSchemaDefaults(fields), defaults),
        jsonSchema: JSONSchema.make(submission),
        createMutationName,
        createInputTypeName,
      }
    })
  }

  executeCreate(
    input: ListCreateInput<TCreate>,
  ): Effect.Effect<string, ListCreateError | ListCreateNotDefinedError, R> {
    if (!this._create)
      return EffectModule.fail(
        new ListCreateNotDefinedError({ listPath: this.node.path }),
      )
    return this._create.submit(input)
  }

  /**
   * Get the GraphQL query name for this list.
   * Format: "list" + PascalCase path (e.g., "listSchoolEmployees")
   *
   * Uses pathToPascalCase to ensure valid GraphQL identifiers even
   * with paths containing hyphens, numbers, or special characters.
   */
  queryName(): string {
    return `list${pathToPascalCase(this.node.path)}`
  }

  /**
   * Execute the list query with the given context.
   *
   * @param ctx - Query context with pagination and optional filter text
   * @returns Effect producing the query result
   */
  executeQuery(
    ctx: ListQueryContext,
  ): Effect.Effect<ListQueryResult<OutputItem<TOutput>>, never, R> {
    return this._query(ctx)
  }

  /**
   * Get the parent OrgUnit of this list.
   */
  get orgUnit(): OrgUnit {
    return this.node.scope as OrgUnit
  }

  /**
   * Get the field names from the output schema.
   * Used to build GraphQL queries with the correct subfield selection.
   */
  outputFieldNames(): string[] {
    return Object.keys(this.output)
  }

  /**
   * Get column metadata from the output schema.
   * Extracts field names, labels, and visibility metadata from schema annotations.
   */
  outputColumns(): ListColumn[] {
    return Object.entries(this.output).map(([field, schema]) =>
      toListColumn(field, schema as Schema.Schema.AnyNoContext),
    )
  }

  /**
   * Get the field names from the effective export schema.
   */
  exportFieldNames(): string[] {
    return Object.keys(this._exportOutput)
  }

  /**
   * Get column metadata from the effective export schema.
   */
  exportColumns(): ListColumn[] {
    return Object.entries(this._exportOutput).map(([field, schema]) =>
      toListColumn(field, schema as Schema.Schema.AnyNoContext),
    )
  }

  /**
   * Execute the effective export query.
   */
  executeExportQuery(
    ctx: ListQueryContext,
  ): Effect.Effect<
    ListQueryResult<OutputItem<ListExportOutputFields<TOutput, TExportOutput>>>,
    never,
    R
  > {
    return this._exportQuery
      ? this._exportQuery(ctx)
      : (this._query(ctx) as Effect.Effect<
          ListQueryResult<
            OutputItem<ListExportOutputFields<TOutput, TExportOutput>>
          >,
          never,
          R
        >)
  }

  /**
   * Check if this list has a detail form defined.
   */
  get hasForm(): boolean {
    return this._form !== undefined
  }

  /**
   * Get the cached form fields.
   * Returns undefined if no form is defined.
   */
  get formFields(): TForm | undefined {
    return this._formFields
  }

  /**
   * Get the GraphQL query name for fetching a single item's detail.
   * Format: "listItem" + PascalCase path (e.g., "listItemSchoolEmployees")
   */
  itemQueryName(): string {
    return `listItem${pathToPascalCase(this.node.path)}`
  }

  /**
   * Execute the item query to fetch a single item by ID.
   * Fails with ListItemQueryNotDefinedError if no itemQuery is defined.
   *
   * @param id - The ID of the item to fetch
   * @returns Effect producing the item or null
   */
  executeItemQuery(
    id: string,
    ctx: ListItemQueryContext = {},
  ): Effect.Effect<OutputItem<TForm> | null, ListItemQueryNotDefinedError, R> {
    if (!this._itemQuery) {
      return EffectModule.fail(
        new ListItemQueryNotDefinedError({ listPath: this.node.path }),
      )
    }
    return this._itemQuery(id, ctx)
  }

  /**
   * Get declared generic controls that can be passed to the item query.
   */
  itemQueryControls(): readonly MetricBreakdownControl[] {
    if (!this._formFields) return []

    const controls = Object.values(this._formFields).flatMap((schema) =>
      collectMetricBreakdownControlsFromAst(
        (schema as Schema.Schema.AnyNoContext).ast,
      ),
    )
    const seen = new Set<string>()

    return controls.filter((control) => {
      if (seen.has(control.name)) return false
      seen.add(control.name)
      return true
    })
  }

  /**
   * Get the field names from the form schema.
   * Returns empty array if no form is defined.
   */
  formFieldNames(): string[] {
    return this._formFields ? Object.keys(this._formFields) : []
  }

  /**
   * Get column metadata from the form schema.
   * Returns empty array if no form is defined.
   */
  formColumns(): ListColumn[] {
    if (!this._formFields) return []

    return Object.entries(this._formFields).map(([field, schema]) =>
      // Form fields are detail/edit metadata, not backend-authored list sort keys.
      toListColumn(field, schema as Schema.Schema.AnyNoContext, {
        sortable: false,
      }),
    )
  }

  /**
   * Generate the browser-safe form definition for the form fields.
   * List forms do not currently support dynamic rules, so the canonical rule
   * channel is always an empty array.
   * Returns null if no form is defined.
   */
  clientFormDefinition(): EffectModule.Effect<
    ClientFormDefinition | null,
    WalkError
  > {
    if (!this._formFields) return EffectModule.succeed(null)
    const effectSchema = SchemaModule.Struct(this._formFields)
    return asClientRepresentation(effectSchema).pipe(
      EffectModule.map((components) => ({ components, rules: [] })),
    )
  }

  /**
   * Generate JSON Schema for the form's submittable fields.
   * Strips read-only and structural-only fields; removes additionalProperties.
   * Returns null if no form is defined.
   */
  formSubmissionSchema(): Record<string, unknown> | null {
    if (!this._formFields) return null

    const effectSchema = SchemaModule.Struct(this.editableFormFields())
    const submission = makeSubmissionSchema(effectSchema)
    const { additionalProperties: _, ...schema } = JSONSchema.make(
      submission,
    ) as JsonSchema7Root & { additionalProperties?: boolean }
    return schema
  }

  /**
   * Get default values for the form fields.
   * Returns null if no form is defined.
   */
  formDefaults(): Record<string, DeepWritable<unknown>> | null {
    if (!this._formFields) return null
    return getSchemaDefaults(this._formFields) as Record<
      string,
      DeepWritable<unknown>
    >
  }

  /**
   * Check if this list has an update function defined.
   */
  get hasUpdate(): boolean {
    return this._update !== undefined
  }

  /**
   * Check if this list has a delete function defined.
   */
  get hasDelete(): boolean {
    return this._delete !== undefined
  }

  /**
   * Get the GraphQL mutation name for updating a list item.
   * Format: "updateListItem" + PascalCase path (e.g., "updateListItemSchoolEmployees")
   */
  updateMutationName(): string {
    return `updateListItem${pathToPascalCase(this.node.path)}`
  }

  /**
   * Get the GraphQL mutation name for deleting a list item.
   * Format: "deleteListItem" + PascalCase path (e.g., "deleteListItemSchoolEmployees")
   */
  deleteMutationName(): string {
    return `deleteListItem${pathToPascalCase(this.node.path)}`
  }

  /**
   * Get the GraphQL input type name for list item updates.
   * Format: "Update" + PascalCase path (e.g., "UpdateSchoolEmployees")
   */
  updateInputTypeName(): string {
    return `Update${pathToPascalCase(this.node.path)}`
  }

  /**
   * Execute the update function to update a single item by ID.
   * Fails with ListItemUpdateNotDefinedError if no update function is defined,
   * or ListUpdateValidationError if server-side validation rejects the input.
   *
   * @param id - The ID of the item to update
   * @param input - The fields to update (flattened submission schema)
   * @returns Effect producing the updated item or null
   */
  executeUpdate(
    id: string,
    input: ListUpdateInput<TForm>,
  ): Effect.Effect<
    OutputItem<TForm> | null,
    ListItemUpdateNotDefinedError | ListUpdateValidationError,
    R
  > {
    if (!this._update) {
      return EffectModule.fail(
        new ListItemUpdateNotDefinedError({ listPath: this.node.path }),
      )
    }
    return this._update(id, input)
  }

  /**
   * Execute the delete function to delete a single item by ID.
   * Fails with ListItemDeleteNotDefinedError if no delete function is defined.
   *
   * @param id - The ID of the item to delete
   * @returns Effect producing void on success
   */
  executeDelete(
    id: string,
  ): Effect.Effect<void, ListItemDeleteNotDefinedError, R> {
    if (!this._delete) {
      return EffectModule.fail(
        new ListItemDeleteNotDefinedError({ listPath: this.node.path }),
      )
    }
    return this._delete(id)
  }

  /**
   * Filter form field entries to only those NOT annotated FormReadOnly=true.
   */
  private editableFormFieldEntries(): [string, Schema.Schema.AnyNoContext][] {
    if (!this._formFields) return []
    return Object.entries(this._formFields).filter(
      ([, schema]) => !isReadOnlyField(schema as Schema.Schema.Any),
    ) as [string, Schema.Schema.AnyNoContext][]
  }

  /**
   * Get editable form fields as a record (excludes FormReadOnly fields).
   * Useful for schema generation where the full field schemas are needed.
   */
  editableFormFields(): Record<string, Schema.Schema.AnyNoContext> {
    return Object.fromEntries(this.editableFormFieldEntries())
  }

  /**
   * Get column metadata for editable form fields only.
   * Returns columns for fields NOT annotated with FormReadOnly.
   */
  editableFormColumns(): ListColumn[] {
    return this.editableFormFieldEntries().map(([field, schema]) =>
      // Editable form fields are not part of the standard list sorting contract.
      toListColumn(field, schema, { sortable: false }),
    )
  }

  /**
   * Get a URL-safe slug derived from the list name.
   * Used for generating unique object keys for CSV exports.
   */
  slugName(): string {
    return this.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
  }

  /**
   * Get the list path in normalized form (with leading slash).
   */
  normalizedPath(): string {
    return normalizePath(this.node.path)
  }
}
