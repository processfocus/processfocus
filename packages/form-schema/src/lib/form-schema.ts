import type { Arbitrary, DateTime, Effect } from "effect"
import { Schema } from "effect"
import isURL from "validator/lib/isURL"
import type { DeferredValue, FormValue } from "./deferred-value"
import {
  FormAutoComplete,
  FormCalendarSlotInput,
  FormDateInput,
  FormDefault,
  FormDescription,
  FormFileInput,
  FormLabel,
  FormListInput,
  FormLookupInput,
  FormNumberInput,
  FormPermission,
  FormProviderUserInput,
  FormRadioInput,
  FormReadOnly,
  FormRequired,
  FormSuggestionInput,
  FormTableInput,
  FormTextAreaInput,
} from "./form-annotations"

// Symbol for marking schemas that should be flattened
export const FLATTEN_SYMBOL = Symbol.for("@pf/form-schema/flatten")

// Symbol for marking structural-only elements (UI-only, excluded from submission)
export const STRUCTURAL_ONLY_SYMBOL = Symbol.for(
  "@pf/form-schema/structural-only",
)

// Symbol for storing the structural element type
export const STRUCTURAL_TYPE_SYMBOL = Symbol.for(
  "@pf/form-schema/structural-type",
)

export const TEXTBLOCK_CONTENT_SYMBOL = Symbol.for(
  "@pf/form-schema/textblock-content",
)
export const TEXTBLOCK_DYNAMIC_CONTENT_SYMBOL = Symbol.for(
  "@pf/form-schema/textblock-dynamic-content",
)

export const METRIC_BREAKDOWN_SYMBOL = Symbol.for(
  "@pf/form-schema/metric-breakdown",
)

export const LINK_URL_SYMBOL = Symbol.for("@pf/form-schema/link-url")
export const LINK_TEXT_SYMBOL = Symbol.for("@pf/form-schema/link-text")
export const LINK_DISPLAY_SYMBOL = Symbol.for("@pf/form-schema/link-display")
export const LINK_COLOR_SYMBOL = Symbol.for("@pf/form-schema/link-color")

export type LinkButtonColor = "blue"

export interface LinkButtonOptions {
  readonly color?: LinkButtonColor
}

export interface DynamicTextBlockOptions {
  /** Placeholder content shown when render-time resolution fails. */
  readonly text: string
  /**
   * Resolves the rendered text when form metadata is requested. Resolution
   * failures are logged by the renderer and leave `text` in place. Any
   * services used by the Effect must be available in the form metadata runtime;
   * this is not compile-time enforced because the environment type is unknown.
   */
  readonly resolve: () => Effect.Effect<string, unknown, unknown>
}

export type MetricBreakdownColor =
  | "amber"
  | "emerald"
  | "rose"
  | "sky"
  | "slate"
  | "violet"

export interface MetricBreakdownBucket {
  readonly label: string
  readonly amount?: number
  readonly description?: string
  readonly color?: MetricBreakdownColor
}

export interface MetricBreakdownField {
  readonly label: string
  readonly value?: string
}

export interface MetricBreakdownSelectorOption {
  readonly label: string
  readonly value: string
}

export interface MetricBreakdownSelectorControl {
  readonly type: "selector"
  /** Item-query/GraphQL argument name for this control. */
  readonly name: string
  /** Optional readable URL parameter key; value wiring is handled by callers. */
  readonly urlParameter?: string
  readonly label: string
  readonly value?: string
  readonly options: readonly [
    MetricBreakdownSelectorOption,
    ...MetricBreakdownSelectorOption[],
  ]
}

export type MetricBreakdownControl = MetricBreakdownSelectorControl

export interface MetricBreakdownDataBucket {
  readonly label: string
  readonly amount: number
  readonly description?: string
  readonly color?: MetricBreakdownColor
}

export interface MetricBreakdownDataField {
  readonly label: string
  readonly value: string
}

export interface MetricBreakdownData {
  readonly total: number
  readonly currency: string
  readonly badge?: string
  readonly fields: readonly MetricBreakdownDataField[]
  readonly buckets: readonly MetricBreakdownDataBucket[]
}

export interface MetricBreakdownOptions {
  readonly title: string
  readonly buckets: readonly MetricBreakdownBucket[]
  readonly badge?: string
  readonly currency?: string
  readonly fields?: readonly MetricBreakdownField[]
  readonly controls?: readonly MetricBreakdownControl[]
  readonly contextFields?: readonly string[]
  readonly dataSource?: "item"
  readonly rendererPluginType?: string
  readonly rendererPluginData?: Record<string, unknown>
}

export const CurrentProviderUser = Symbol.for(
  "@pf/form-schema/current-provider-user",
)

// Branded type to mark schemas for type-level flattening
export type FlattenMarker = { readonly __flatten: unique symbol }

// Branded type to mark structural-only elements
export type StructuralOnlyMarker = { readonly __structuralOnly: unique symbol }

export type ReadOnlyMarker = { readonly __readOnly: unique symbol }
export type ProviderUserMarker = { readonly __providerUser: unique symbol }
export type LookupMarker = { readonly __lookup: unique symbol }
export type CalendarSlotMarker = { readonly __calendarSlot: unique symbol }
/** Preserve read-only classification in downstream process-state inference. */
export const ReadOnly = <A, I, R>(
  schema: Schema.Schema<A, I, R>,
): Schema.Schema<A, I, R> & ReadOnlyMarker =>
  schema.annotations({ [FormReadOnly]: true }) as Schema.Schema<A, I, R> &
    ReadOnlyMarker

type PresentationOnly<Field> = Field extends StructuralOnlyMarker
  ? true
  : Field extends FlattenMarker & { readonly fields: infer Fields }
    ? Exclude<
        {
          [Key in keyof Fields]-?: PresentationOnly<
            Exclude<Fields[Key], undefined>
          >
        }[keyof Fields],
        true
      > extends never
      ? true
      : false
    : false

/** Optional definition keys are presentation only; optional values use Schema.optional. */
export type StableFormFields<Fields> = {
  [Key in keyof Fields]: undefined extends Fields[Key]
    ? PresentationOnly<Exclude<Fields[Key], undefined>> extends true
      ? Fields[Key]
      : never
    : Fields[Key] extends { readonly fields: infer Nested }
      ? Fields[Key] & { readonly fields: StableFormFields<Nested> }
      : Fields[Key]
}

// Wrapper function - creates an annotated struct for semantic grouping with flattened type
export const Wrapper = <Fields extends Schema.Struct.Fields>(
  fields: Fields & StableFormFields<NoInfer<Fields>>,
): Schema.Struct<Fields> & FlattenMarker =>
  Schema.Struct<Fields>(fields).annotations({
    [FLATTEN_SYMBOL]: true,
  }) as Schema.Struct<Fields> & FlattenMarker

// Helper to create custom structural-only elements
const structuralElement = <T extends Record<string, unknown>>(
  type: string,
  data?: T,
): Schema.Schema.Any & StructuralOnlyMarker =>
  Schema.Undefined.annotations({
    [STRUCTURAL_ONLY_SYMBOL]: true,
    [STRUCTURAL_TYPE_SYMBOL]: type,
    ...data,
  }) as unknown as Schema.Schema.Any & StructuralOnlyMarker

// Generic structural-only marker for custom use cases
export const StructuralOnly = structuralElement("structural")

// Specific structural-only helpers for common UI elements
export const Divider = structuralElement("divider")
export const TextBlock = (text: string) =>
  structuralElement("textblock", { [TEXTBLOCK_CONTENT_SYMBOL]: text })
export const DynamicTextBlock = (options: DynamicTextBlockOptions) =>
  structuralElement("textblock", {
    [TEXTBLOCK_CONTENT_SYMBOL]: options.text,
    [TEXTBLOCK_DYNAMIC_CONTENT_SYMBOL]: options.resolve,
  })
export const Image = (src: string, alt?: string) =>
  structuralElement("image", { src, alt })
const linkElement = (
  url: string,
  text: string,
  display?: "button",
  options?: LinkButtonOptions,
) =>
  structuralElement("link", {
    [LINK_URL_SYMBOL]: url,
    [LINK_TEXT_SYMBOL]: text,
    ...(display ? { [LINK_DISPLAY_SYMBOL]: display } : {}),
    ...(options?.color ? { [LINK_COLOR_SYMBOL]: options.color } : {}),
  })
export const Link = (url: string, text: string) => linkElement(url, text)
export const LinkButton = (
  url: string,
  text: string,
  options?: LinkButtonOptions,
) => linkElement(url, text, "button", options)
export const MetricBreakdown = (options: MetricBreakdownOptions) =>
  structuralElement("metric-breakdown", { [METRIC_BREAKDOWN_SYMBOL]: options })

const isMetricBreakdownBucket = (
  value: unknown,
): value is MetricBreakdownBucket => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false
  }

  return typeof (value as Record<string, unknown>)["label"] === "string"
}

const isMetricBreakdownSelectorOption = (
  value: unknown,
): value is MetricBreakdownSelectorOption => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false
  }

  const record = value as Record<string, unknown>
  return (
    typeof record["label"] === "string" && typeof record["value"] === "string"
  )
}

const isMetricBreakdownControl = (
  value: unknown,
): value is MetricBreakdownControl => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false
  }

  const record = value as Record<string, unknown>

  return (
    record["type"] === "selector" &&
    typeof record["name"] === "string" &&
    (record["urlParameter"] === undefined ||
      typeof record["urlParameter"] === "string") &&
    typeof record["label"] === "string" &&
    (record["value"] === undefined || typeof record["value"] === "string") &&
    Array.isArray(record["options"]) &&
    record["options"].length > 0 &&
    record["options"].every(isMetricBreakdownSelectorOption)
  )
}

export const isMetricBreakdownOptions = (
  value: unknown,
): value is MetricBreakdownOptions => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false
  }

  const record = value as Record<string, unknown>
  const dataSource = record["dataSource"]
  const controls = record["controls"]
  const rendererPluginType = record["rendererPluginType"]
  const rendererPluginData = record["rendererPluginData"]

  return (
    typeof record["title"] === "string" &&
    Array.isArray(record["buckets"]) &&
    record["buckets"].every(isMetricBreakdownBucket) &&
    (controls === undefined ||
      (Array.isArray(controls) && controls.every(isMetricBreakdownControl))) &&
    (dataSource === undefined || dataSource === "item") &&
    (rendererPluginType === undefined ||
      typeof rendererPluginType === "string") &&
    (rendererPluginData === undefined ||
      (typeof rendererPluginData === "object" &&
        rendererPluginData !== null &&
        !Array.isArray(rendererPluginData)))
  )
}

/**
 * Type for field options, generic over the field's value type.
 * This ensures type safety for default values.
 */
export interface FieldOptions<T = unknown> {
  label?: FormValue<string>
  description?: FormValue<string>
  autoComplete?: FormValue<string>
  readOnly?: boolean
  permission?: FieldPermissionMetadata
  /**
   * Default value for the field.
   * Can be a static value or a function (closure) that returns the value.
   * Must match the field's value type.
   *
   * @example Static default
   * ```typescript
   * TextField({ default: "N/A" })
   * ```
   *
   * @example Lazy default using execution state
   * ```typescript
   * const flow = process.start(prevStep)
   * new Form(flow, "Approval", {
   *   form: ({ value }) => ({
   *     cost: TextField({ default: value((state) => String(state.value)) }),
   *     count: NumberField({ default: value((state) => state.count) }),
   *   }),
   * })
   * ```
   */
  default?: FormValue<T> | (() => T)
}

export interface ListFieldMetadata {
  readonly addButtonLabel?: string
}

export const isListFieldMetadata = (
  value: unknown,
): value is ListFieldMetadata =>
  typeof value === "object" &&
  value !== null &&
  (!("addButtonLabel" in value) || typeof value.addButtonLabel === "string")

export interface ListFieldOptions<T> extends FieldOptions<T> {
  readonly addButtonLabel?: string
}

export interface FieldPermissionRoleRef {
  readonly node: { readonly path: string }
}

export interface FieldPermissionMetadata {
  readonly modify: FieldPermissionRoleRef
}

export const isFieldPermissionMetadata = (
  value: unknown,
): value is FieldPermissionMetadata =>
  typeof value === "object" &&
  value !== null &&
  "modify" in value &&
  typeof value.modify === "object" &&
  value.modify !== null &&
  "node" in value.modify &&
  typeof value.modify.node === "object" &&
  value.modify.node !== null &&
  "path" in value.modify.node &&
  typeof value.modify.node.path === "string"

// Helper to apply annotations to a schema
// Note: options type is separate from schema type to allow each field helper
// to enforce its own type constraint on default values
export const applyFieldAnnotations = <A, I, R>(
  schema: Schema.Schema<A, I, R>,
  options?: FieldOptions<unknown>,
): Schema.Schema<A, I, R> => {
  if (!options) return schema

  const annotations: Record<symbol, unknown> = {}
  if (options.label !== undefined) {
    annotations[FormLabel] = options.label
  }
  if (options.description !== undefined) {
    annotations[FormDescription] = options.description
  }
  if (options.autoComplete !== undefined) {
    annotations[FormAutoComplete] = options.autoComplete
  }
  if (options.readOnly !== undefined) {
    annotations[FormReadOnly] = options.readOnly
  }
  if (isFieldPermissionMetadata(options.permission)) {
    annotations[FormPermission] = options.permission
  }
  if (options.default !== undefined) {
    annotations[FormDefault] = options.default
  }

  return Object.getOwnPropertySymbols(annotations).length > 0
    ? schema.annotations(annotations)
    : schema
}

/**
 * Create a text field with optional label and description
 *
 * @example
 * ```typescript
 * const schema = Schema.Struct({
 *   street: TextField({ label: "Street name", description: "Your street address" })
 * })
 * ```
 */
export function TextField(
  options: FieldOptions<string> & { readonly readOnly: true },
): Schema.Schema<string, string, never> & ReadOnlyMarker
export function TextField(
  options?: FieldOptions<string>,
): Schema.Schema<string, string, never>
export function TextField(
  options?: FieldOptions<string>,
): Schema.Schema<string, string, never> {
  return applyFieldAnnotations(Schema.String, options)
}

export function TextArea(
  options: FieldOptions<string> & { readonly readOnly: true },
): Schema.Schema<string, string, never> & ReadOnlyMarker
export function TextArea(
  options?: FieldOptions<string>,
): Schema.Schema<string, string, never>
export function TextArea(
  options?: FieldOptions<string>,
): Schema.Schema<string, string, never> {
  return applyFieldAnnotations(
    Schema.String.annotations({ [FormTextAreaInput]: true }),
    options,
  )
}

/**
 * Create a text field from a transformation schema
 *
 * @example
 * ```typescript
 * const schema = Schema.Struct({
 *   date: TextFieldFrom(Schema.DateFromString, { label: "Birth date" })
 * })
 * ```
 */
export const TextFieldFrom = <I, R>(
  schema: Schema.Schema<string, I, R>,
  options?: FieldOptions<I>,
): Schema.Schema<string, I, R> => applyFieldAnnotations(schema, options)

/**
 * Validate that a string is a well-formed HTTPS URL.
 *
 * Uses `validator/lib/isURL` with `protocols: ["https"]` and
 * `require_protocol: true` so bare hostnames and non-HTTPS schemes are
 * rejected. TLDs are required to catch typos like `https://x`.
 *
 * Exported so server-side code (e.g. `updateRegion`) can reuse the same
 * check without pulling in the full form-schema field constructor.
 */
export const isHttpsUrl = (value: string): boolean =>
  isURL(value, {
    protocols: ["https"],
    require_protocol: true,
    require_tld: true,
  })

const httpsUrlSchema = Schema.String.pipe(
  // Strict runtime validation via validator.js.
  Schema.filter(isHttpsUrl, {
    message: () => "Must be a valid HTTPS URL (e.g. https://example.com/path)",
  }),
  // Guide arbitrary generation for auto-gen test data only — not a
  // runtime filter.
  Schema.annotations({
    arbitrary: (): Arbitrary.LazyArbitrary<string> => (fc) =>
      fc.webUrl({ validSchemes: ["https"] }),
  }),
)

/**
 * Create an HTTPS URL text field with built-in validation via
 * `validator.js`.
 *
 * The pattern annotation guides Effect's arbitrary generator so that
 * auto-generated test data produces valid HTTPS URLs. The `isHttpsUrl`
 * filter then performs the real validation using `validator/lib/isURL`.
 *
 * @example
 * ```typescript
 * const schema = Schema.Struct({
 *   endpoint: HttpsUrlField({ label: "OTLP Endpoint" })
 * })
 * ```
 */
export const HttpsUrlField = (
  options?: FieldOptions<string>,
): Schema.Schema<string, string, never> => {
  return applyFieldAnnotations(httpsUrlSchema, options)
}

/**
 * Create a number field with optional label and description
 *
 * @example
 * ```typescript
 * const schema = Schema.Struct({
 *   age: NumberField({ label: "Your age", description: "Age in years" })
 * })
 * ```
 */
export const NumberField = (
  options?: FieldOptions<number>,
): Schema.Schema<number, number, never> =>
  applyFieldAnnotations(Schema.Number, options)

/**
 * Create a number field from a transformation schema
 *
 * @example
 * ```typescript
 * const schema = Schema.Struct({
 *   age: NumberFieldFrom(Schema.NumberFromString, { label: "Your age" })
 * })
 * ```
 */
export const NumberFieldFrom = <I, R>(
  schema: Schema.Schema<number, I, R>,
  options?: FieldOptions<I> & { required?: boolean },
): Schema.Schema<number, I, R> => {
  const base = options?.required
    ? schema.annotations({
        jsonSchema: { minLength: 1 },
        [FormRequired]: true,
        [FormNumberInput]: true,
      })
    : schema.annotations({
        [FormNumberInput]: true,
      })
  return applyFieldAnnotations(base, options)
}

export const DateField = (
  options?: FieldOptions<string>,
): Schema.Schema<DateTime.Utc, string, never> =>
  applyFieldAnnotations(
    Schema.DateTimeUtc.annotations({ [FormDateInput]: true }),
    options,
  )

const requiredBooleanSchema = Schema.Boolean.pipe(
  Schema.filter((b): b is boolean => b === true, {
    message: () => "This field is required",
    jsonSchema: { type: "boolean", enum: [true] },
    [FormRequired]: true,
  }),
)

/**
 * Create a boolean field with optional label and description
 *
 * When `required: true`, the field must be checked (true) to pass validation.
 *
 * @example
 * ```typescript
 * const schema = Schema.Struct({
 *   acceptTerms: BooleanField({ label: "Accept terms and conditions" }),
 *   approved: BooleanField({ label: "I approve", required: true })
 * })
 * ```
 */
export const BooleanField = (
  options?: FieldOptions<boolean> & { required?: boolean },
): Schema.Schema<boolean, boolean, never> => {
  const base = options?.required ? requiredBooleanSchema : Schema.Boolean
  return applyFieldAnnotations(base, options)
}

/**
 * File upload metadata embedded in the FormFileInput annotation.
 * Flows through the AST walker to the client representation.
 */
export interface FileFieldMetadata {
  readonly documentStore: string
  readonly accept?: string
  readonly maxSize?: number
}

export interface DocumentStoreRef {
  readonly node: { readonly path: string }
}

/**
 * Create a file upload field with optional accept filter and max size.
 *
 * The underlying value is a `fileId` string (returned by the document store
 * after upload). The frontend renders this as a file picker that handles
 * upload automatically.
 *
 * @example
 * ```typescript
 * const schema = Schema.Struct({
 *   artifact: FileField({ label: "Deployment artifact", accept: ".zip", maxSize: 100_000_000 })
 * })
 * ```
 */
export const FileField = (
  options: FieldOptions<string> & {
    documentStore: DocumentStoreRef
    accept?: string
    maxSize?: number
  },
): Schema.Schema<string, string, never> => {
  const storePath = options.documentStore.node.path.startsWith("/")
    ? options.documentStore.node.path
    : `/${options.documentStore.node.path}`

  const metadata: FileFieldMetadata = {
    documentStore: storePath,
    ...(options.accept != null && { accept: options.accept }),
    ...(options.maxSize != null && { maxSize: options.maxSize }),
  }
  const base = Schema.String.annotations({
    [FormFileInput]: metadata,
  })
  return applyFieldAnnotations(base, options)
}

/**
 * Create a list/array field whose items are structs.
 *
 * Produces `Schema.Array(Schema.Struct(itemFields))` with optional annotations.
 *
 * @example
 * ```typescript
 * const schema = Schema.Struct({
 *   students: ListField({
 *     first_name: TextField({ label: "First name" }),
 *     parent_email: TextField({ label: "Parent email" }),
 *   }, { label: "Students" }),
 * })
 * ```
 */
export const ListField = <Fields extends Schema.Struct.Fields>(
  itemFields: Fields & StableFormFields<NoInfer<Fields>>,
  options?: ListFieldOptions<ReadonlyArray<Schema.Struct.Encoded<Fields>>>,
) => {
  const schema = Schema.Array(Schema.Struct<Fields>(itemFields))
  const annotatedSchema =
    options?.addButtonLabel === undefined
      ? schema
      : schema.annotations({
          [FormListInput]: {
            addButtonLabel: options.addButtonLabel,
          } satisfies ListFieldMetadata,
        })

  return applyFieldAnnotations(
    annotatedSchema,
    options,
  ) as unknown as Schema.Schema<
    ReadonlyArray<Schema.Struct.Type<Fields>>,
    ReadonlyArray<Schema.Struct.Encoded<Fields>>,
    Schema.Struct.Context<Fields>
  > &
    ListFieldMarker<Fields>
}

export type ListFieldMarker<Fields extends Schema.Struct.Fields> = {
  readonly __listFields: Fields
}

export type TableFieldMarker = { readonly __tableField: unique symbol }

/**
 * Create a read-only table field whose rows are structs.
 *
 * The row field labels become the table column headings. Table fields are for
 * display only and are excluded from form submissions via the read-only marker.
 */
export const TableField = <Fields extends Schema.Struct.Fields>(
  itemFields: Fields & StableFormFields<NoInfer<Fields>>,
  options?: Omit<
    FieldOptions<ReadonlyArray<Schema.Struct.Encoded<Fields>>>,
    "permission" | "readOnly"
  >,
) =>
  applyFieldAnnotations(
    Schema.Array(Schema.Struct<Fields>(itemFields)).annotations({
      [FormTableInput]: true,
    }),
    { ...options, readOnly: true },
  ) as Schema.Schema<
    ReadonlyArray<Schema.Schema.Type<Schema.Struct<Fields>>>,
    ReadonlyArray<Schema.Schema.Encoded<Schema.Struct<Fields>>>,
    never
  > &
    TableFieldMarker &
    ReadOnlyMarker

/**
 * An item returned by a lookup query.
 */
export interface LookupItem {
  readonly value: string
  readonly label: string
}

export interface RadioFieldOption<Value extends string = string> {
  readonly value: Value
  readonly label: string
}

export interface RadioFieldMetadata<Value extends string = string> {
  readonly options: readonly [
    RadioFieldOption<Value>,
    ...RadioFieldOption<Value>[],
  ]
}

export type RadioFieldMarker = { readonly __radioField: unique symbol }

type RadioOptionValues<
  Options extends readonly [
    RadioFieldOption<string>,
    ...RadioFieldOption<string>[],
  ],
> = Options[number]["value"]

export const RadioField = <
  const Options extends readonly [
    RadioFieldOption<string>,
    ...RadioFieldOption<string>[],
  ],
>(
  options: FieldOptions<RadioOptionValues<Options>> & {
    readonly options: Options
  },
): Schema.Schema<
  RadioOptionValues<Options>,
  RadioOptionValues<Options>,
  never
> &
  RadioFieldMarker => {
  const values = options.options.map((option) => option.value) as [
    RadioOptionValues<Options>,
    ...RadioOptionValues<Options>[],
  ]
  const metadata: RadioFieldMetadata<RadioOptionValues<Options>> = {
    options: options.options,
  }

  return applyFieldAnnotations(
    Schema.Literal(...values).annotations({ [FormRadioInput]: metadata }),
    options,
  ) as Schema.Schema<
    RadioOptionValues<Options>,
    RadioOptionValues<Options>,
    never
  > &
    RadioFieldMarker
}

/**
 * Metadata stored in the FormLookupInput annotation.
 * Contains the optional query function that searches for matching items.
 * When no query is provided, the field is still marked as a lookup
 * but the query must be supplied via `Form.lookups.<field>.setQuery()`.
 */
export interface LookupFieldMetadata {
  readonly query?: (
    filter: string,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<LookupItem>, unknown, unknown>
}

type QueryValue<Query> = Query | DeferredValue<Query>

export interface CalendarSlotItem {
  readonly value: string
  readonly startsAt: string
  readonly endsAt: string
  readonly label?: string | undefined
}

export type CalendarSlotWeekday = 0 | 1 | 2 | 3 | 4 | 5 | 6

export interface CalendarSlotCalendarMetadata {
  readonly weekStartsOn?: CalendarSlotWeekday | undefined
  readonly businessDays?: readonly CalendarSlotWeekday[] | undefined
}

export interface CalendarSlotFieldMetadata {
  readonly timeZone: string
  readonly locale: string
  readonly query?: () => Effect.Effect<
    ReadonlyArray<CalendarSlotItem>,
    unknown,
    unknown
  >
  readonly calendar?: CalendarSlotCalendarMetadata | undefined
  readonly emptyMessageHtml?: string | undefined
  readonly loadErrorMessageHtml?: string | undefined
}

export type CalendarSlotFieldOptions = FieldOptions<string> & {
  readonly timeZone: string
  /** BCP 47 locale used for date/time display, e.g. "en-NZ". */
  readonly locale?: string | undefined
  readonly query?: QueryValue<
    () => Effect.Effect<ReadonlyArray<CalendarSlotItem>, unknown, unknown>
  >
  readonly calendar?: CalendarSlotCalendarMetadata | undefined
  readonly emptyMessageHtml?: string | undefined
  readonly loadErrorMessageHtml?: string | undefined
}

/**
 * Create a searchable lookup/select field.
 *
 * The underlying value is a string (the selected item's value/ID).
 * The `query` function is embedded in the schema annotation and executed
 * server-side by the `lookupSuggestions` GraphQL resolver, which calls
 * `Form.executeLookup()` to provide the Effect runtime context. Any
 * service dependencies used via `yield*` are resolved automatically.
 *
 * @param options - Standard field options (label, description, etc.) plus
 *   a `query` function receiving a search filter and max result count,
 *   returning an Effect that yields {@link LookupItem LookupItem[]}.
 *
 * @example
 * ```typescript
 * const schema = Schema.Struct({
 *   regionId: LookupField({
 *     label: "Region",
 *     description: "AWS region for this project",
 *     query: (filter, limit) =>
 *       Effect.gen(function* () {
 *         const ops = yield* OrgOperations
 *         return yield* ops.searchRegions(filter, limit)
 *       }),
 *   }),
 * })
 * ```
 */
export const LookupField = (
  options: FieldOptions<string> & {
    query?: QueryValue<
      (
        filter: string,
        limit: number,
      ) => Effect.Effect<ReadonlyArray<LookupItem>, unknown, unknown>
    >
  },
): Schema.Schema<string, string, never> & LookupMarker => {
  const metadata = {
    ...(options.query != null && { query: options.query }),
  }
  const base = Schema.String.annotations({
    [FormLookupInput]: metadata,
  })
  return applyFieldAnnotations(base, options) as Schema.Schema<
    string,
    string,
    never
  > &
    LookupMarker
}

/**
 * Create a text field with searchable suggestions.
 *
 * Unlike {@link LookupField}, the submitted value can be either one of the
 * suggestion values or arbitrary text entered by the user. Use this for fields
 * where known records are helpful but not exhaustive.
 */
export const SuggestionField = (
  options: FieldOptions<string> & {
    query?: QueryValue<
      (
        filter: string,
        limit: number,
      ) => Effect.Effect<ReadonlyArray<LookupItem>, unknown, unknown>
    >
  },
): Schema.Schema<string, string, never> & LookupMarker => {
  const metadata = {
    ...(options.query != null && { query: options.query }),
  }
  const base = Schema.String.annotations({
    [FormLookupInput]: metadata,
    [FormSuggestionInput]: true,
  })
  return applyFieldAnnotations(base, options) as Schema.Schema<
    string,
    string,
    never
  > &
    LookupMarker
}

export const CalendarSlotField = (
  options: CalendarSlotFieldOptions,
): Schema.Schema<string, string, never> & CalendarSlotMarker => {
  const metadata = {
    timeZone: options.timeZone,
    locale: options.locale ?? "en",
    ...(options.query != null && { query: options.query }),
    ...(options.calendar != null && { calendar: options.calendar }),
    ...(options.emptyMessageHtml != null && {
      emptyMessageHtml: options.emptyMessageHtml,
    }),
    ...(options.loadErrorMessageHtml != null && {
      loadErrorMessageHtml: options.loadErrorMessageHtml,
    }),
  }
  return applyFieldAnnotations(
    Schema.String.annotations({ [FormCalendarSlotInput]: metadata }),
    options,
  ) as Schema.Schema<string, string, never> & CalendarSlotMarker
}

export type ProviderUserDefault = string | typeof CurrentProviderUser

export type ProviderUserFieldOptions = Omit<
  FieldOptions<ProviderUserDefault>,
  "default"
> & {
  readonly default?:
    | FormValue<ProviderUserDefault>
    | (() => ProviderUserDefault)
}

/**
 * Create a provider-user field.
 *
 * The submitted value is still a string: the selected provider user's id or
 * email. `CurrentProviderUser` can be used as a symbolic default for later
 * runtime resolution.
 */
export const ProviderUserField = (
  options?: ProviderUserFieldOptions,
): Schema.Schema<string, string, never> & ProviderUserMarker =>
  applyFieldAnnotations(
    Schema.String.annotations({ [FormProviderUserInput]: true }),
    options,
  ) as Schema.Schema<string, string, never> & ProviderUserMarker
