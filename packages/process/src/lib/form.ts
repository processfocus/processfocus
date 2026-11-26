import type { StoredEmailAttachment } from "@processfocus/runtime"
import {
  Data,
  type DateTime,
  type Duration,
  Effect,
  Option,
  Schema,
  SchemaAST,
  SchemaGetter,
} from "effect"
import {
  type CalendarSlotFieldMetadata,
  type CalendarSlotItem,
  FormCalendarSlotInput,
  FormDefault,
  FormDescription,
  FormLabel,
  FormLookupInput,
  type FormPresentation,
  FormStaticText,
  LINK_TEXT_SYMBOL,
  LINK_URL_SYMBOL,
  type LookupFieldMetadata,
  type LookupItem,
  type LookupMarker,
  type StableFormFields,
  TEXTBLOCK_CONTENT_SYMBOL,
  fieldAnnotation,
  hasFlattenAnnotation,
  hasStructuralOnlyAnnotation,
} from "@pf/form-schema"
import {
  type DeepWritable,
  executableOriginalValues,
  getSchemaDefaults,
  submissionSchemaSync as makeSubmissionSchema,
} from "@pf/form-submission-schema"
import { isProcess } from "./brands"
import type {
  FlowContext,
  FormStepMeta,
  MergeFormStep,
  MergeSteps,
  StepMeta,
  SummaryContext,
} from "./flow-context"
import {
  type FlowPath,
  type MergeState,
  assertSameProcess,
  wrapInFlowPath,
} from "./flow-path"
import {
  type FormAuthoring,
  assertResolvedFormFields,
  createFormAuthoring,
} from "./form-authoring"
import { FormDecorationError, mapFormFields } from "./form-decoration"
import { mergeFormDefaults, resolveFormFieldDefaults } from "./form-defaults"
import {
  LookupAccessor,
  type LookupOverride,
  type LookupOverrideStore,
} from "./lookup-accessor"
import { pathToPascalCase } from "./org-utils"
import type { InferFormSchemaType, Process, ResolveStepOutput } from "./process"
import type { Role } from "./role"
import { type IStepScope, Step, type StepProps } from "./step"
import {
  type AuthorTaggedError,
  type ForEachConfig,
  NotAForEachStepError,
} from "./system-step"

export type { FormAuthoring } from "./form-authoring"
export { FormDecorationError } from "./form-decoration"

const astChildKeys = [
  "type",
  "types",
  "from",
  "to",
  "elements",
  "rest",
] as const

const isAst = (value: unknown): value is SchemaAST.AST =>
  typeof value === "object" &&
  value !== null &&
  "_tag" in value &&
  typeof (value as { readonly _tag?: unknown })._tag === "string"

const getRawAnnotation = (
  value: { readonly annotations?: Record<PropertyKey, unknown> },
  annotationId: symbol,
): Option.Option<unknown> => {
  const annotation = value.annotations?.[annotationId]
  return annotation === undefined ? Option.none() : Option.some(annotation)
}

const getSchemaAnnotationDeep = (
  schema: Schema.Top,
  annotationId: symbol,
): Option.Option<unknown> => {
  const visit = (
    ast: SchemaAST.AST,
    seen: Set<SchemaAST.AST>,
  ): Option.Option<unknown> => {
    const direct = getAnnotation(ast, annotationId)
    if (Option.isSome(direct)) return direct
    if (seen.has(ast)) return Option.none()
    seen.add(ast)

    if (SchemaAST.isSuspend(ast)) {
      const result = visit(ast.thunk(), seen)
      if (Option.isSome(result)) return result
    }

    const record = ast as unknown as Record<string, unknown>
    if (Array.isArray(record["propertySignatures"])) {
      for (const property of record["propertySignatures"]) {
        if (typeof property !== "object" || property === null) continue
        const propertyRecord = property as {
          readonly annotations?: Record<PropertyKey, unknown>
          readonly type?: unknown
        }
        const propertyAnnotation = getRawAnnotation(
          propertyRecord,
          annotationId,
        )
        if (Option.isSome(propertyAnnotation)) return propertyAnnotation
        if (isAst(propertyRecord.type)) {
          const result = visit(propertyRecord.type, seen)
          if (Option.isSome(result)) return result
        }
      }
    }

    if (Array.isArray(record["indexSignatures"])) {
      for (const signature of record["indexSignatures"]) {
        if (typeof signature !== "object" || signature === null) continue
        const signatureRecord = signature as {
          readonly parameter?: unknown
          readonly type?: unknown
        }
        for (const child of [signatureRecord.parameter, signatureRecord.type]) {
          if (!isAst(child)) continue
          const result = visit(child, seen)
          if (Option.isSome(result)) return result
        }
      }
    }

    for (const key of astChildKeys) {
      const child = record[key]
      if (Array.isArray(child)) {
        for (const item of child) {
          if (!isAst(item)) continue
          const result = visit(item, seen)
          if (Option.isSome(result)) return result
        }
        continue
      }
      if (isAst(child)) {
        const result = visit(child, seen)
        if (Option.isSome(result)) return result
      }
    }

    return Option.none()
  }

  return visit(schema.ast, new Set())
}

const getSchemaAst = (schema: unknown): SchemaAST.AST | undefined => {
  if (
    (typeof schema !== "object" && typeof schema !== "function") ||
    schema === null ||
    !("ast" in schema)
  ) {
    return undefined
  }

  const ast = (schema as { readonly ast?: unknown }).ast
  return isAst(ast) ? ast : undefined
}

const getStructFields = (schema: unknown): Schema.Struct.Fields | undefined => {
  if (
    (typeof schema !== "object" && typeof schema !== "function") ||
    schema === null ||
    !("fields" in schema)
  ) {
    return undefined
  }

  const fields = (schema as { readonly fields?: unknown }).fields
  return typeof fields === "object" && fields !== null
    ? (fields as Schema.Struct.Fields)
    : undefined
}

const getTypeLiteralFields = (
  ast: SchemaAST.AST | undefined,
): Schema.Struct.Fields | undefined => {
  if (!ast) return undefined
  if (ast.encoding) return getTypeLiteralFields(SchemaAST.toEncoded(ast))
  if (ast._tag === "Union") {
    for (const member of ast.types) {
      const fields = getTypeLiteralFields(member)
      if (fields) return fields
    }
    return undefined
  }
  if (ast._tag !== "Objects") return undefined
  return Object.fromEntries(
    ast.propertySignatures.map((property) => [
      property.name,
      Schema.make(property.type),
    ]),
  )
}

const getAstFields = (schema: unknown): Schema.Struct.Fields | undefined => {
  const ast = isAst(schema) ? schema : getSchemaAst(schema)
  return getTypeLiteralFields(ast)
}

const getNestedFields = (
  schema: unknown,
): Record<string, unknown> | undefined =>
  getStructFields(schema) ?? getAstFields(schema)

/**
 * Counts leaf fields in a nested structure.
 * A "leaf" is any primitive value or empty array.
 * Objects and non-empty arrays are recursively traversed.
 *
 * @param value - The value to count leaf fields in
 * @returns The number of leaf fields
 */
export const countLeafFields = (value: unknown): number => {
  if (value === null || value === undefined) {
    return 0
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return 1
    }

    return value.reduce<number>(
      (total, item) => total + countLeafFields(item),
      0,
    )
  }

  if (typeof value === "object") {
    const entries = Object.values(value as Record<string, unknown>)

    if (entries.length === 0) {
      return 0
    }

    return entries.reduce<number>(
      (total, item) => total + countLeafFields(item),
      0,
    )
  }

  return 1
}

/**
 * Typed default values for a form's input fields.
 * Returns properly typed defaults based on TInput schema.
 */
type FormDefaults<TInput extends Schema.Struct.Fields> = {
  [K in keyof TInput]: DeepWritable<Schema.Schema.Type<TInput[K]>>
}

/**
 * Summary type for todo cards.
 * Record where keys are labels and values are the display strings.
 * Using Record prevents duplicate labels.
 */
export type Summary = Record<string, string>

/** Client-safe rejection from an authored form submission callback. */
export class FormSubmissionError extends Data.TaggedError(
  "FormSubmissionError",
)<{
  readonly field: string
  readonly message: string
}> {}

/** An unauthenticated process start, independent of External Participants. */
export interface FormAnonymousPageConfig {
  /** Stable address segment. Use an unguessable value for private reception pages. */
  readonly address: string
  readonly afterSubmit: "restart" | "thank-you"
}

export interface FormEmbedConfig {
  readonly sites: readonly string[]
  readonly thankYou: string
  /**
   * Name of the submitted field that identifies the external participant.
   * The field must exist in the flattened submission schema; runtime validation
   * is still responsible for rejecting non-email values.
   */
  readonly externalParticipantEmailField: string
}

export interface PublicCompletionRecipient {
  readonly email: string
  readonly displayName?: string
}

export interface PublicCompletionEmailTemplate {
  readonly id: string
  readonly variables?: Record<string, string | number>
}

export interface PublicCompletionCorrectionConfig<
  TState = Record<string, unknown>,
  TSteps extends Record<string, StepMeta> = Record<string, StepMeta>,
  TItem = unknown,
> {
  readonly enabled: true
  /**
   * Returns the process-state patch for a corrected public recipient email.
   * This can be invoked again after a non-transactional enqueue failure, so it
   * must be idempotent for the current process state and corrected email.
   */
  readonly applyEmail: (
    state: TState,
    correctedEmail: string,
    ctx: FlowContext<TSteps>,
    item: TItem,
  ) => MaybeEffect<Record<string, unknown>>
}

type MaybeEffect<T> = T | Effect.Effect<T, AuthorTaggedError, unknown>
type SummaryResult = Summary | Effect.Effect<Summary, never, never>
type AssigneeResult =
  | string
  | undefined
  // E stays never: getAssignee contains failures. R stays open for services.
  | Effect.Effect<string | undefined, never, unknown>

const defaultProviderUserDisplay = {
  display: (providerUserIdOrEmail: string) =>
    Effect.succeed(providerUserIdOrEmail),
}

const toSummaryContext = <TSteps extends Record<string, StepMeta>>(
  ctx: FlowContext<TSteps> | SummaryContext<TSteps>,
): SummaryContext<TSteps> => {
  if ("providerUserDisplay" in ctx) return ctx

  return {
    ...ctx,
    providerUserDisplay: defaultProviderUserDisplay,
  }
}

export interface FormPublicCompletionConfig<
  TState,
  TSteps extends Record<string, StepMeta>,
  TItem,
> {
  /**
   * Resolve who receives the public completion link. This may run while the
   * todo is still waiting, before completed step context is available, so it
   * should depend on process state and the optional forEach item only. If it
   * returns an Effect, that Effect must not require additional context.
   */
  readonly recipient: (
    state: TState,
    ctx: FlowContext<TSteps>,
    item: TItem,
  ) => MaybeEffect<string | PublicCompletionRecipient>
  readonly expiresAt: (
    state: TState,
    ctx: FlowContext<TSteps>,
    item: TItem,
  ) => MaybeEffect<DateTime.DateTime>
  readonly subject?: (
    state: TState,
    ctx: FlowContext<TSteps>,
    item: TItem,
    publicUrl: string,
    expiresAt: DateTime.DateTime,
  ) => MaybeEffect<string>
  readonly body?: (
    state: TState,
    ctx: FlowContext<TSteps>,
    item: TItem,
    publicUrl: string,
    expiresAt: DateTime.DateTime,
  ) => MaybeEffect<string>
  readonly template?: (
    state: TState,
    ctx: FlowContext<TSteps>,
    item: TItem,
    publicUrl: string,
    expiresAt: DateTime.DateTime,
  ) => MaybeEffect<PublicCompletionEmailTemplate>
  /** Overrides the organisation notification sender for this invitation. */
  readonly from?: string
  readonly attachments?: (
    state: TState,
    ctx: FlowContext<TSteps>,
    item: TItem,
  ) => MaybeEffect<readonly StoredEmailAttachment[]>
  readonly correction?: PublicCompletionCorrectionConfig<TState, TSteps, TItem>
  readonly thankYou?:
    | string
    | ((
        state: TState,
        ctx: FlowContext<TSteps>,
        item: TItem,
      ) => MaybeEffect<string>)
  /** Public form heading override for this completion link. */
  readonly formTitle?: string
  /** Public form supporting copy override for this completion link. */
  readonly formDescription?: string
}

const normalizeEmbedSite = (site: string): string => {
  let url: URL

  try {
    url = new URL(site)
  } catch {
    throw new Error(`Invalid embed site origin: ${site}`)
  }

  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(
      `Embed site must be an exact origin without path, query, or hash: ${site}`,
    )
  }

  return url.origin
}

const normalizeEmbedConfig = (
  config: FormEmbedConfig,
  submissionFields: Schema.Struct.Fields,
): FormEmbedConfig => {
  const sites = [...new Set(config.sites.map(normalizeEmbedSite))]

  if (sites.length === 0) {
    throw new Error("Embedded forms must configure at least one allowed site")
  }

  const thankYou = config.thankYou.trim()
  if (thankYou.length === 0) {
    throw new Error("Embedded forms must configure non-empty thank-you copy")
  }

  const externalParticipantEmailField =
    config.externalParticipantEmailField.trim()
  if (externalParticipantEmailField.length === 0) {
    throw new Error(
      "Embedded forms must configure an external participant email field",
    )
  }

  if (!Object.hasOwn(submissionFields, externalParticipantEmailField)) {
    throw new Error(
      `Embedded form external participant email field "${externalParticipantEmailField}" is not a submittable form field`,
    )
  }

  return {
    sites,
    thankYou,
    externalParticipantEmailField,
  }
}

/**
 * Flatten a defaults record according to form schema structure.
 * Wrapper fields' nested values are spread into the parent level.
 * Structural-only fields are excluded (they have no values).
 * Read-only fields are kept (they carry resolved values).
 */
const flattenDefaults = (
  defaults: Record<string, unknown>,
  schema: Schema.Struct<Schema.Struct.Fields>,
): Record<string, unknown> => {
  const flat: Record<string, unknown> = {}

  for (const [key, field] of Object.entries(schema.fields)) {
    const fieldAsAny = field as Schema.Top

    // Skip structural-only fields (no values)
    if (hasStructuralOnlyAnnotation(fieldAsAny)) continue

    // Check for flatten annotation (Wrapper)
    if (
      hasFlattenAnnotation(fieldAsAny) &&
      fieldAsAny.ast._tag === "Objects" &&
      "fields" in fieldAsAny
    ) {
      // Wrapper defaults may already be flat when they come from schema
      // defaults, while resolved default annotations are still nested.
      const nestedValue = defaults[key]
      const nested =
        typeof nestedValue === "object" && nestedValue !== null
          ? (nestedValue as Record<string, unknown>)
          : defaults
      const nestedFlat = flattenDefaults(
        nested,
        fieldAsAny as Schema.Struct<Schema.Struct.Fields>,
      )
      Object.assign(flat, nestedFlat)
    } else if (key in defaults) {
      const value = defaults[key]
      const nested = getStructFields(field)
      flat[key] =
        nested &&
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value)
          ? flattenDefaults(
              value as Record<string, unknown>,
              Schema.Struct(nested),
            )
          : value
    }
  }

  return flat
}

type FormBindings<F extends Schema.Struct.Fields> = {
  readonly [K in keyof F]?: FormPresentation & {
    readonly default?: F[K]["Encoded"]
  } & (F[K] extends LookupMarker
      ? { readonly query?: LookupFieldMetadata["query"] }
      : unknown)
}

/**
 * Base props shared by all Form steps.
 */
interface FormStepPropsBase<
  TState,
  TSteps extends Record<string, StepMeta | FormStepMeta> = Record<
    string,
    never
  >,
  TInput extends Schema.Struct.Fields = Schema.Struct.Fields,
  TItem = undefined,
> extends Omit<StepProps<TInput>, "output" | "role"> {
  /**
   * The role responsible for completing this form.
   * Required for Form steps (unlike SystemSteps which have no role).
   */
  readonly role: Role
  /**
   * Additional roles that can also complete this form step.
   * Primary role is tried first in authorization; supporting roles provide
   * fallback authorization without needing custom Cedar policies.
   */
  readonly supportingRoles?: Role[]
  /**
   * Form builder function that defines the form fields.
   *
   * Use `() => ({...})` for static forms. Inline helpers defer expressions
   * that need execution state, completed-step context or a forEach item.
   *
   * Runtime helper callbacks receive `(state, ctx, item)` for each instance.
   *
   * The `state` parameter contains accumulated state from all previous steps.
   * The `ctx` parameter provides access to step metadata like who completed
   * previous steps.
   *
   * @example
   * ```typescript
   * // Static form (no state access needed)
   * const submit = new Form(process, "Submit", {
   *   form: () => ({
   *     item: ES.String,
   *     value: ES.Number,
   *   }),
   *   role: employeeRole,
   * })
   *
   * // Dynamic form with state access
   * const approve = new Form(flow, "Approve", {
   *   form: ({ value }) => ({
   *     // state.item is typed from previous step
   *     itemDisplay: TextField({
   *       label: "Item",
   *       readOnly: true,
   *       default: value((state) => state.item),
   *     }),
   *     // ctx.step provides typed access to completed steps
   *     requester: TextField({
   *       label: "Requester",
   *       readOnly: true,
   *       default: value((_state, ctx) => ctx.step.submit.providerUser.name),
   *     }),
   *     approved: ES.Boolean,
   *   }),
   *   role: managerRole,
   * })
   * ```
   */
  readonly form:
    | Schema.Struct<TInput>
    | ((
        helpers: FormAuthoring<TState, TSteps, TItem>,
      ) => StaticFormDeclaration<TInput>)

  /** Server-only request bindings; fields and their value contracts remain static. */
  readonly bindings?: (
    state: TState,
    ctx: FlowContext<TSteps>,
    item: TItem,
  ) => FormBindings<TInput>

  /** Browser-safe module exporting the same static schema supplied to form. */
  readonly browser?: {
    readonly entrypoint: string
    readonly exportName: string
    /** Server-only, request-local public data keyed by submitted field path. */
    readonly resolvePluginConfiguration?: () => Effect.Effect<
      Readonly<Record<string, unknown>>,
      never,
      unknown
    >
  }

  /**
   * Function to compute summary for todo cards.
   * Returns contextual information displayed on the todo card.
   * Keys are labels, values are display strings (may contain HTML).
   *
   * The second parameter `ctx` provides access to step metadata
   * like who completed previous steps.
   *
   * @example
   * ```typescript
   * const approve = new Form(flow, "Approve", {
   *   form: () => ({ approved: ES.Boolean }),
   *   summary: (state, ctx) => ({
   *     When: formatDate(state.requestedDate),
   *     Requester: ctx.step.submitRequest.providerUser.name,
   *   }),
   *   role: managerRole,
   * })
   * ```
   */
  readonly summary?: (
    state: TState,
    ctx: SummaryContext<TSteps>,
    item: TItem,
  ) => SummaryResult

  /**
   * Optional direct provider-user assignee for todos created for this form.
   * The returned value may be a provider-user id or email; runtimes normalize
   * it before persisting `to_do.assigned_to_provider_user`.
   */
  readonly assignee?: (
    state: TState,
    ctx: FlowContext<TSteps>,
    item: TItem,
  ) => AssigneeResult

  /**
   * Persist domain data after validation, inside the submission transaction.
   * Failure rolls back submission. Completion retries can rerun this callback:
   * use transactional database writes, never irreversible external effects.
   */
  readonly onSubmit?: (
    input: InferFormSchemaType<TInput>,
  ) => Effect.Effect<void, FormSubmissionError, unknown>

  /**
   * Optional struct-level validation that runs after individual field
   * validation during schema decode. Receives the flat decoded struct
   * (wrapper fields are flattened), so it can perform cross-field checks.
   *
   * Return `undefined` to pass, or a `string` error message to fail.
   *
   * @example
   * ```typescript
   * const form = new Form(process, "Deploy", {
   *   form: () => ({
   *     projectId: LookupField({ label: "Project" }),
   *     environmentId: LookupField({ label: "Environment" }),
   *   }),
   *   validate: (input) =>
   *     Effect.gen(function* () {
   *       const ops = yield* OrgOperations
   *       const belongs = yield* ops.environmentBelongsToProject(
   *         input.environmentId,
   *         input.projectId,
   *       )
   *       if (!belongs)
   *         return "Environment does not belong to the selected project"
   *       return undefined
   *     }),
   *   role: employeeRole,
   * })
   * ```
   */
  readonly validate?: (
    input: InferFormSchemaType<TInput>,
    // biome-ignore lint/suspicious/noExplicitAny: context type depends on which services the callback uses
  ) => Effect.Effect<string | undefined, never, any>

  /**
   * Optional configuration for rendering this start form as an anonymous embed.
   * Allowed sites are exact origins only.
   */
  readonly anonymousPage?: FormAnonymousPageConfig

  readonly embed?: FormEmbedConfig

  /**
   * Optional external completion email for non-start forms. The regular role
   * todo remains staff-visible; this adds a public completion link email.
   */
  readonly publicCompletion?: FormPublicCompletionConfig<TState, TSteps, TItem>
}

/**
 * Props specific to Form steps.
 * When `forEach` is present, `TItem` is the type of each forEach item.
 * When absent, `TItem` is `undefined` (no item parameter).
 *
 * @typeParam TState - Accumulated state from previous steps
 * @typeParam TSteps - Record of completed step metadata for ctx.step access
 * @typeParam TInput - Form input schema (inferred from form function return type)
 * @typeParam TItem - Type of forEach item (undefined when no forEach)
 * @typeParam TIsForEach - Whether this step uses forEach semantics
 */
export type FormStepProps<
  TState,
  TSteps extends Record<string, StepMeta | FormStepMeta> = Record<
    string,
    never
  >,
  TInput extends Schema.Struct.Fields = Schema.Struct.Fields,
  TItem = undefined,
  TIsForEach extends boolean = false,
> = FormStepPropsBase<TState, TSteps, TInput, TItem> &
  (TIsForEach extends true
    ? { forEach: ForEachConfig<TState, TSteps, TItem> }
    : { forEach?: never })

type IsUnion<Value, Whole = Value> = Value extends Whole
  ? [Whole] extends [Value]
    ? false
    : true
  : never

export type StaticFormDeclaration<Fields extends Schema.Struct.Fields> =
  Fields &
    (true extends IsUnion<Fields> ? never : StableFormFields<NoInfer<Fields>>)

export type FormProps<
  TState,
  TSteps extends Record<string, StepMeta | FormStepMeta>,
  TInput extends Schema.Struct.Fields,
  TItem = undefined,
> = FormStepPropsBase<TState, TSteps, TInput, TItem> & {
  readonly forEach?: ForEachConfig<TState, TSteps, TItem>
}

/**
 * Form step class with support for typed state and context access.
 *
 * When using a Step/FlowPath as scope, the state and steps types are
 * automatically inferred from the accumulated state of previous steps.
 *
 * @typeParam TState - Accumulated state type from completed steps
 * @typeParam TSteps - Record of completed step metadata for ctx.step access
 * @typeParam TInput - Form input schema (inferred from form function return type)
 * @typeParam TId - Step identifier literal type
 * @typeParam TItem - Type of forEach item (undefined when no forEach)
 * @typeParam TIsForEach - Whether this step uses forEach semantics
 *
 * @example
 * ```typescript
 * // Static form with Process scope
 * const submit = new Form(process, "Submit", {
 *   form: () => ({ item: ES.String, value: ES.Number }),
 *   role: employeeRole,
 * })
 *
 * // Dynamic form with Step/Flow scope - state is inferred
 * const flow = process.start(submit)
 * const approve = new Form(flow, "Approve", {
 *   form: ({ value }) => ({
 *     item: TextField({ default: value((state) => state.item), readOnly: true }),
 *     approved: ES.Boolean,
 *   }),
 *   summary: (state, ctx) => ({
 *     Item: state.item,
 *     Requester: ctx.step.submit.providerUser.name,
 *   }),
 *   role: managerRole,
 * })
 * ```
 */

/**
 * Error raised when a lookup field is not found or is not annotated
 * as a lookup field in the form schema.
 */
export class LookupFieldNotFoundError extends Data.TaggedError(
  "LookupFieldNotFoundError",
)<{
  readonly fieldName: string
  readonly formStep: string
  readonly message: string
}> {}

export class Form<
    TState = Record<string, never>,
    TSteps extends Record<string, StepMeta | FormStepMeta> = Record<
      string,
      never
    >,
    TInput extends Schema.Struct.Fields = Schema.Struct.Fields,
    const TId extends string = string,
    TItem = undefined,
    TIsForEach extends boolean = [TItem] extends [undefined]
      ? false
      : undefined extends TItem
        ? boolean
        : true,
  >
  extends Step<TState, TInput, TId, true, TIsForEach>
  implements LookupOverrideStore
{
  /**
   * The form fields schema extracted from the form function.
   */
  private _formFields: TInput

  /**
   * Request-local resolution of the static declaration's lazy expressions.
   */
  private _formFn: (
    state: TState,
    ctx: FlowContext<TSteps>,
    item: TItem,
  ) => TInput

  private readonly _onSubmit: FormProps<
    TState,
    TSteps,
    TInput,
    TItem
  >["onSubmit"]

  /**
   * The summary function, stored for computing summary from process state.
   */
  private _summaryFn:
    | ((
        state: TState,
        ctx: SummaryContext<TSteps>,
        item: TItem,
      ) => SummaryResult)
    | undefined

  private _assigneeFn:
    | ((state: TState, ctx: FlowContext<TSteps>, item: TItem) => AssigneeResult)
    | undefined

  /**
   * The forEach items function, stored for runtime execution.
   * Undefined when no forEach is configured.
   */
  private _forEachItemsFn:
    | ((
        state: TState,
        ctx: FlowContext<TSteps>,
      ) => Effect.Effect<ReadonlyArray<TItem>, AuthorTaggedError, unknown>)
    | undefined

  /**
   * The full validation schema: Schema.Struct(fields) optionally refined
   * with a struct-level filterEffect from the validate prop.
   */
  private _schema: Schema.Top

  /**
   * The flat submission validation schema: submissionSchema(fields) optionally
   * refined with a struct-level filterEffect from the validate prop.
   * Used for server-side validation where wrapper nesting is irrelevant.
   */
  private _submissionEffectSchema: Schema.Top

  /**
   * Lookup query overrides set via `this.lookups.<field>.setQuery()`.
   */
  private _lookupOverrides = new Map<string, LookupOverride>()
  private _lookupResolvers = new Map<
    string,
    NonNullable<LookupFieldMetadata["resolve"]>
  >()

  _setLookupResolver(
    fieldName: string,
    resolve: NonNullable<LookupFieldMetadata["resolve"]>,
  ): void {
    this._lookupResolvers.set(fieldName, resolve)
  }

  resolveLookupSelection(
    fieldName: string,
    value: string,
    fields: Schema.Struct.Fields = this._formFields,
  ): Effect.Effect<LookupItem | null, unknown, unknown> {
    const field = makeSubmissionSchema(Schema.Struct(fields)).fields[fieldName]
    const metadata = field
      ? (Option.getOrUndefined(
          getSchemaAnnotationDeep(field as Schema.Top, FormLookupInput),
        ) as LookupFieldMetadata | undefined)
      : undefined
    const resolve = this._lookupResolvers.get(fieldName) ?? metadata?.resolve
    // Dependent lookup capabilities remain on their existing typed route.
    if (
      !metadata ||
      this._lookupOverrides.get(fieldName)?.dependencies?.length ||
      !resolve
    )
      return Effect.succeed(null)
    return resolve(value).pipe(
      Effect.map((item) => (item?.value === value ? item : null)),
    )
  }

  override readonly isForm = true

  /** Attach a deadline. The owner output is not yet available. */
  onDeadline<
    TOutput extends Schema.Struct.Fields | undefined,
    THandlerId extends string,
    THandlerIsForm extends boolean = false,
  >(
    name: string,
    options: {
      readonly handler: Step<TState, TOutput, THandlerId, THandlerIsForm, false>
      readonly interrupting?: boolean
    } & (
      | { readonly after: Duration.Duration; readonly at?: never }
      | {
          readonly at: (state: TState) => DateTime.DateTime
          readonly after?: never
        }
    ),
  ): FlowPath<
    MergeState<TState, ResolveStepOutput<TOutput, THandlerIsForm>>,
    TOutput,
    THandlerIsForm extends true
      ? MergeFormStep<TSteps, THandlerId>
      : MergeSteps<TSteps, THandlerId>
  > {
    if (!name.trim()) {
      throw new Error("A deadline name must not be empty")
    }
    if (this.deadlines.some((deadline) => deadline.name === name)) {
      throw new Error(`Duplicate deadline "${name}" on ${this.node.path}`)
    }
    assertSameProcess(options.handler, this.process)
    this.process.addEdge(this, options.handler, {
      deadlineName: name,
      interrupting: options.interrupting ?? false,
    })
    this.deadlines.push({
      name,
      interrupting: options.interrupting ?? false,
      timing: options.at ? { at: options.at } : { after: options.after },
    })
    // As for normal flow paths, only the phantom accumulated state changes.
    return wrapInFlowPath(options.handler, this.process) as FlowPath<
      MergeState<TState, ResolveStepOutput<TOutput, THandlerIsForm>>,
      TOutput,
      THandlerIsForm extends true
        ? MergeFormStep<TSteps, THandlerId>
        : MergeSteps<TSteps, THandlerId>
    >
  }

  readonly lookups: {
    readonly [K in keyof TInput & string]: LookupAccessor<TInput, K>
  }

  readonly sharedSchema: Schema.Struct<TInput>

  readonly browser: FormProps<TState, TSteps, TInput, TItem>["browser"]

  readonly anonymousPage: FormAnonymousPageConfig | undefined

  readonly embed: FormEmbedConfig | undefined

  readonly supportingRoles: readonly Role[] | undefined

  readonly publicCompletion:
    | FormPublicCompletionConfig<TState, TSteps, TItem>
    | undefined

  /**
   * Create a Form step.
   *
   * @param scope - Parent Process or Step. When a Step is provided, state type is inferred.
   * @param id - Unique identifier for this step
   * @param props - Form properties including form function and optional summary
   */
  constructor(
    scope:
      | Process
      | IStepScope<TState, TSteps>
      | FlowPath<TState, Schema.Struct.Fields | undefined, TSteps>,
    id: TId,
    props: FormProps<TState, TSteps, TInput, TItem>,
  ) {
    if (props.publicCompletion && isProcess(scope)) {
      throw new Error("publicCompletion is only valid on non-start forms")
    }

    if (
      props.supportingRoles?.some((r) => r.node.path === props.role.node.path)
    ) {
      throw new Error(
        `Form "${id}": primary role must not be in supportingRoles`,
      )
    }

    const supportingPaths = props.supportingRoles?.map((r) => r.node.path) ?? []
    if (new Set(supportingPaths).size !== supportingPaths.length) {
      throw new Error(`Form "${id}": supportingRoles contains duplicate roles`)
    }

    // Build step props - conditionally include optional properties
    const stepProps = {
      role: props.role,
      ...(props.name !== undefined && { name: props.name }),
      ...(props.purpose !== undefined && { purpose: props.purpose }),
      ...(props.phase !== undefined && { phase: props.phase }),
      ...(props.sla !== undefined && { sla: props.sla }),
      ...(props.alwaysNotify !== undefined && {
        alwaysNotify: props.alwaysNotify,
      }),
    } as StepProps<TInput>

    super(scope, id, stepProps)

    const authoring = createFormAuthoring<TState, TSteps, TItem>()
    this.browser = props.browser
    const fields = Object.freeze({
      ...(Schema.isSchema(props.form)
        ? props.form.fields
        : props.form(authoring.helpers)),
    })
    this.sharedSchema = Schema.isSchema(props.form)
      ? props.form
      : Schema.Struct(fields)
    this._formFields = authoring.project(fields)
    this._formFn = (state, ctx, item) => {
      const resolved = authoring.project(fields, [state, ctx, item])
      const bindings = props.bindings?.(state, ctx, item)
      if (!bindings) return resolved
      const decorated: Record<string, Schema.Constraint> = { ...resolved }
      for (const key of Object.keys(bindings)) {
        if (!Object.hasOwn(resolved, key))
          throw new FormDecorationError({
            path: `form.${key}`,
            message: `Unknown form binding: ${key}`,
          })
      }
      for (const key in resolved) {
        const binding = bindings[key]
        if (!binding) continue
        const query = "query" in binding ? binding.query : undefined
        const lookup = fieldAnnotation(resolved[key].ast, FormLookupInput)
        if (
          query !== undefined &&
          (typeof query !== "function" || lookup === undefined)
        )
          throw new FormDecorationError({
            path: `form.${key}`,
            message: `Invalid lookup binding: ${key}`,
          })
        const annotations = {
          ...(query === undefined
            ? {}
            : {
                [FormLookupInput]: {
                  ...(typeof lookup === "object" && lookup !== null
                    ? lookup
                    : {}),
                  query,
                },
              }),
          ...(binding.label === undefined
            ? {}
            : { [FormLabel]: binding.label }),
          ...(binding.description === undefined
            ? {}
            : { [FormDescription]: binding.description }),
          ...(binding.text === undefined
            ? {}
            : {
                [FormStaticText]: binding.text,
                [TEXTBLOCK_CONTENT_SYMBOL]: binding.text,
                [LINK_TEXT_SYMBOL]: binding.text,
              }),
          ...(binding.href === undefined
            ? {}
            : { [LINK_URL_SYMBOL]: binding.href }),
          ...(binding.default === undefined
            ? {}
            : { [FormDefault]: binding.default }),
        }
        // Decoration changes only presentation/default annotations, retaining the field contract.
        decorated[key] = mapFormFields(
          { field: resolved[key] },
          (ast) => Schema.make<Schema.Top>(ast).annotate(annotations).ast,
          (existing) => ({ ...existing, ...annotations }),
        ).field
      }
      return decorated as TInput
    }

    assertResolvedFormFields(this._formFields)

    // Build validation schema: struct of fields, optionally refined
    const struct = Schema.Struct(this._formFields)
    this._onSubmit = props.onSubmit
    this._schema = props.validate
      ? struct.pipe(
          Schema.decode({
            decode: SchemaGetter.checkEffect(
              props.validate as (
                input: typeof struct.Type,
              ) => ReturnType<NonNullable<typeof props.validate>>,
            ),
            encode: SchemaGetter.passthrough(),
          }),
        )
      : struct

    // Build flat submission schema for server-side validation.
    // Flattens wrapper fields and removes structural-only/read-only fields.
    // Authoring-time errors (collisions / invalid flatten) throw the TaggedError.
    const flatSubmission = makeSubmissionSchema(struct)
    this._submissionEffectSchema = props.validate
      ? flatSubmission.pipe(
          Schema.decode({
            decode: SchemaGetter.checkEffect(
              props.validate as (
                input: typeof flatSubmission.Type,
              ) => ReturnType<NonNullable<typeof props.validate>>,
            ),
            encode: SchemaGetter.passthrough(),
          }),
        )
      : flatSubmission

    // Build typed lookup accessors for every field in TInput
    this.lookups = Object.fromEntries(
      Object.keys(this._formFields).map((k) => [
        k,
        new LookupAccessor<TInput, string>(this, k),
      ]),
    ) as { readonly [K in keyof TInput & string]: LookupAccessor<TInput, K> }

    if (props.anonymousPage) {
      if (props.embed || props.publicCompletion) {
        throw new Error(
          "An Anonymous Page cannot also be an embed or public completion",
        )
      }
      if (!/^[A-Za-z0-9_-]+$/.test(props.anonymousPage.address)) {
        throw new Error(
          "Anonymous Page address must be a URL-safe path segment",
        )
      }
    }
    this.anonymousPage = props.anonymousPage
    this.embed = props.embed
      ? normalizeEmbedConfig(props.embed, flatSubmission.fields)
      : undefined
    this.supportingRoles = props.supportingRoles
    this.publicCompletion = props.publicCompletion

    if (props.summary) {
      this._summaryFn = props.summary
    }

    if (props.assignee) {
      this._assigneeFn = props.assignee
    }

    if (props.forEach) {
      this._forEachItemsFn = props.forEach.items
      // Override brand property for cross-bundle detection
      ;(this as { hasForEach: boolean }).hasForEach = true
    }
  }

  /** @internal Called by LookupAccessor/LookupBuilder to store overrides. */
  _setLookupOverride(fieldName: string, override: LookupOverride): void {
    this._lookupOverrides.set(fieldName, override)
  }

  /**
   * Returns all lookup overrides set via `this.lookups`.
   * Used by the schema generator to emit per-lookup GraphQL queries.
   */
  lookupOverrides(): ReadonlyMap<string, LookupOverride> {
    return this._lookupOverrides
  }

  private _prefill:
    | {
        dependency: string
        fields: readonly string[]
        concealed: readonly string[]
        load: (
          value: string,
        ) => Effect.Effect<Record<string, unknown>, unknown, unknown>
      }
    | undefined

  /** Fresh selection-dependent values. Concealed fields still travel on submission. */
  prefillOn<
    const K extends keyof TInput & string,
    const F extends keyof Schema.Struct.Type<TInput> & keyof TInput & string,
  >(
    dependency: K,
    options: {
      fields: readonly F[]
      concealed?: readonly F[]
      load: (
        value: string,
      ) => Effect.Effect<Pick<Schema.Struct.Type<TInput>, F>, unknown, unknown>
    },
  ): this {
    this._prefill = {
      dependency,
      fields: options.fields,
      concealed: options.concealed ?? [],
      load: options.load,
    }
    return this
  }

  prefillQuery(): typeof this._prefill {
    return this._prefill
  }

  prefillQueryName(): string {
    return `${this.lookupQueryName("prefill")}Values`
  }

  submissionPath(
    path: readonly (string | number)[],
  ): readonly (string | number)[] {
    const flat: Array<string | number> = []
    let currentFields: Schema.Struct.Fields | undefined = this._formFields
    for (const segment of path) {
      if (typeof segment !== "string" || !currentFields) {
        flat.push(segment)
        continue
      }

      const fieldSchema = currentFields[segment] as Schema.Top | undefined
      if (!fieldSchema) {
        flat.push(segment)
        currentFields = undefined
        continue
      }

      const nestedFields = getNestedFields(fieldSchema)
      const isFlattened = hasFlattenAnnotation(fieldSchema)

      if (isFlattened && nestedFields) {
        currentFields = nestedFields as Schema.Struct.Fields
      } else {
        flat.push(segment)
        currentFields = nestedFields as Schema.Struct.Fields | undefined
      }
    }

    return flat
  }

  /**
   * Returns the GraphQL query name for a dependent lookup field.
   * E.g. `lookupDevopsAddEnvironmentInputEnvironmentDetailsStageId`
   */
  lookupQueryName(fieldName: string): string {
    return `lookup${pathToPascalCase(this.node.path)}${fieldName.charAt(0).toUpperCase() + fieldName.slice(1)}`
  }

  /**
   * Get the output schema for this form.
   * Returns the fields extracted from the form function.
   */
  override get output(): TInput {
    return this._formFields
  }

  /**
   * Get the output validation schema for this form.
   * Returns Schema.Struct(fields), optionally refined with a struct-level
   * filterEffect when a `validate` callback was provided.
   */
  override get outputSchema(): Schema.Top {
    return this._schema
  }

  /** Invoke only after the runtime has validated and authorized the submission. */
  executeSubmit(
    input: InferFormSchemaType<TInput>,
  ): Effect.Effect<void, FormSubmissionError, unknown> {
    return Effect.suspend(() => this._onSubmit?.(input) ?? Effect.void)
  }

  /**
   * Get the flat submission validation schema for this form.
   * Returns submissionSchema(fields) (wrapper fields flattened, read-only/
   * structural-only removed), optionally refined with a struct-level
   * filterEffect when a `validate` callback was provided.
   *
   * Used by start/complete resolvers for server-side validation where
   * wrapper nesting should not affect persisted state shape.
   */
  override get submissionEffectSchema(): Schema.Top {
    return this._submissionEffectSchema
  }

  /**
   * Get the forEach items for this form.
   * Returns the array of items, where each item is context data for one form instance.
   * Only available when forEach is configured.
   */
  forEachItems(
    state: TState,
    ctx: FlowContext<TSteps>,
  ): Effect.Effect<
    ReadonlyArray<TItem>,
    NotAForEachStepError | AuthorTaggedError,
    unknown
  > {
    if (!this._forEachItemsFn) {
      return Effect.fail(new NotAForEachStepError({ stepPath: this.stepKey }))
    }
    return this._forEachItemsFn(state, ctx)
  }

  /**
   * Get the form fields with defaults resolved against the given state.
   * Resolves inline lazy expressions against actual execution data.
   *
   * @param state - Process state to resolve defaults against
   * @param ctx - Flow context with step metadata
   * @param item - Optional forEach item data for per-instance context
   * @throws FormDecorationError when a runtime value or presentation is invalid
   * @returns Validated schema fields with defaults properly resolved
   */
  getFieldsWithState(
    state: TState,
    ctx: FlowContext<TSteps>,
    item?: TItem,
  ): TInput {
    return this._formFn(state, ctx, item as TItem)
  }

  /**
   * Check if this form has a summary function defined.
   */
  get hasSummaryFunction(): boolean {
    return this._summaryFn !== undefined
  }

  get hasAssigneeFunction(): boolean {
    return this._assigneeFn !== undefined
  }

  /**
   * Resolve the assignee for this form given the current process state.
   * Returns undefined if no assignee function is defined.
   *
   * Errors in user-provided assignee functions are logged and undefined is
   * returned (same containment as getSummary / dynamic text blocks). Callers
   * must treat `hasAssigneeFunction === true` as “an assignee callback exists”,
   * not as a guarantee that a provider user id will be resolved.
   */
  getAssignee(
    state: TState,
    ctx: FlowContext<TSteps>,
    item?: TItem,
  ): Effect.Effect<string | undefined, never, unknown> {
    if (!this._assigneeFn) {
      return Effect.succeed(undefined)
    }
    const assigneeFn = this._assigneeFn

    return Effect.try(() => assigneeFn(state, ctx, item as TItem)).pipe(
      Effect.flatMap((assignee) =>
        Effect.isEffect(assignee) ? assignee : Effect.succeed(assignee),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning(
          `Failed to resolve assignee for form "${this.node.id}"`,
          { cause },
        ).pipe(Effect.as(undefined)),
      ),
    )
  }

  /**
   * Compute the summary for this form given the current process state.
   * Returns an empty object if no summary function is defined.
   *
   * Errors in user-provided summary functions are logged and an empty object is returned.
   *
   * @param state - Process state to compute summary from
   * @param ctx - Flow context with step metadata
   * @param item - Optional forEach item data for per-instance context
   * @returns Effect producing summary record (label -> value)
   */
  getSummary(
    state: TState,
    ctx: FlowContext<TSteps> | SummaryContext<TSteps>,
    item?: TItem,
  ): Effect.Effect<Summary, never> {
    if (!this._summaryFn) {
      return Effect.succeed({})
    }

    const summaryFn = this._summaryFn
    const summaryCtx = toSummaryContext(ctx)
    return Effect.try(() => summaryFn(state, summaryCtx, item as TItem)).pipe(
      // Summary callbacks may return either a plain object or an Effect while
      // existing synchronous callbacks are migrated. This runtime bridge keeps
      // the public summary API source-compatible without forcing every caller
      // into Effect immediately.
      Effect.flatMap((summary) =>
        Effect.isEffect(summary) ? summary : Effect.succeed(summary),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning(
          `Failed to compute summary for form "${this.node.id}"`,
          { cause },
        ).pipe(Effect.as({})),
      ),
    )
  }

  /**
   * Resolve default values from schema annotations.
   * Walks through the schema fields and executes any default functions.
   * Errors in user-provided default functions are logged and the field is skipped.
   */
  private resolveFieldDefaults(
    fields: Schema.Struct.Fields,
    currentProviderUser?: string,
  ): Effect.Effect<Record<string, unknown>, never> {
    return resolveFormFieldDefaults(fields, currentProviderUser ?? "")
  }

  /**
   * Get the number of leaf fields in this form.
   * Counts primitive fields recursively, not just top-level keys.
   */
  get totalFields(): number {
    return countLeafFields(getSchemaDefaults(this.output))
  }

  /**
   * Get the schema defaults for this form's input fields.
   * Returns type-compatible placeholder values (empty strings, 0, false, etc.).
   *
   * We need this as input for Tanstack Form in order to display the
   * initial values for a form.
   *
   * @returns Record of field names to their default values
   */
  defaults(): FormDefaults<TInput> {
    return getSchemaDefaults(this.output) as FormDefaults<TInput>
  }

  /**
   * Resolve initial metadata defaults without process state.
   * This keeps start-step metadata from leaking symbolic defaults to clients.
   */
  resolveInitialDefaults(
    currentProviderUser?: string,
  ): Effect.Effect<Record<string, unknown>, never> {
    return Effect.gen({ self: this }, function* () {
      const resolvedDefaults = yield* this.resolveFieldDefaults(
        this._formFields,
        currentProviderUser,
      )

      return flattenDefaults(
        mergeFormDefaults(this.defaults(), resolvedDefaults),
        Schema.Struct(
          this._formFields as Schema.Struct.Fields,
        ) as Schema.Struct<Schema.Struct.Fields>,
      )
    })
  }

  /**
   * Execute a lookup query for a specific field in this form.
   *
   * Checks for an override (set via `this.lookups`) first, then falls back
   * to the annotation-based query from the LookupField constructor.
   *
   * @param fieldName - The name of the lookup field
   * @param filter - Search filter string
   * @param limit - Maximum number of results
   * @param deps - Dependency values for dependent lookups (field name → value)
   * @returns Effect producing an array of LookupItems
   */
  executeLookup(
    fieldName: string,
    filter: string,
    limit: number,
    deps: Record<string, string | undefined> = {},
  ): Effect.Effect<ReadonlyArray<LookupItem>, unknown, unknown> {
    // Check overrides first
    const override = this._lookupOverrides.get(fieldName)
    if (override) {
      const input: Record<string, string> = { filter }
      for (const [k, v] of Object.entries(deps)) {
        if (v !== undefined) {
          input[k] = v
        }
      }
      return override.query(input, limit)
    }

    // Fall back to annotation-based query
    const fieldSchema = this._formFields[fieldName]
    if (!fieldSchema) {
      return new LookupFieldNotFoundError({
        fieldName,
        formStep: this.stepKey,
        message: `Lookup field "${fieldName}" not found in form "${this.stepKey}"`,
      })
    }

    const metadata = Option.getOrUndefined(
      getSchemaAnnotationDeep(fieldSchema as Schema.Top, FormLookupInput),
    ) as LookupFieldMetadata | undefined
    if (!metadata?.query) {
      return new LookupFieldNotFoundError({
        fieldName,
        formStep: this.stepKey,
        message: `Field "${fieldName}" in form "${this.stepKey}" is not a lookup field (no query defined)`,
      })
    }

    return metadata.query(filter, limit)
  }

  /** Re-run the form so lookup query closures can see process state. */
  executeLookupWithState(
    fieldName: string,
    filter: string,
    limit: number,
    state: TState,
    ctx: FlowContext<TSteps>,
    item?: TItem,
    deps: Record<string, string | undefined> = {},
  ): Effect.Effect<ReadonlyArray<LookupItem>, unknown, unknown> {
    if (this._lookupOverrides.has(fieldName))
      return this.executeLookup(fieldName, filter, limit, deps)
    const fields = this.getFieldsWithState(state, ctx, item)
    const fieldSchema = fields[fieldName]
    if (!fieldSchema) {
      return new LookupFieldNotFoundError({
        fieldName,
        formStep: this.stepKey,
        message: `Lookup field "${fieldName}" not found in form "${this.stepKey}"`,
      })
    }

    const metadata = Option.getOrUndefined(
      getSchemaAnnotationDeep(fieldSchema as Schema.Top, FormLookupInput),
    ) as LookupFieldMetadata | undefined
    if (!metadata?.query) {
      return new LookupFieldNotFoundError({
        fieldName,
        formStep: this.stepKey,
        message: `Field "${fieldName}" in form "${this.stepKey}" is not a lookup field (no query defined)`,
      })
    }

    return metadata.query(filter, limit)
  }

  private _runCalendarSlotQuery(
    fieldName: string,
    fieldSchema: unknown | undefined,
  ): Effect.Effect<ReadonlyArray<CalendarSlotItem>, unknown, unknown> {
    if (!fieldSchema) {
      return new LookupFieldNotFoundError({
        fieldName,
        formStep: this.stepKey,
        message: `Calendar slot field "${fieldName}" not found in form "${this.stepKey}"`,
      })
    }

    const metadata = Option.getOrUndefined(
      getSchemaAnnotationDeep(fieldSchema as Schema.Top, FormCalendarSlotInput),
    ) as CalendarSlotFieldMetadata | undefined
    if (!metadata?.query) {
      return new LookupFieldNotFoundError({
        fieldName,
        formStep: this.stepKey,
        message: `Field "${fieldName}" in form "${this.stepKey}" is not a calendar slot field (no query defined)`,
      })
    }

    return metadata.query()
  }

  executeCalendarSlots(
    fieldName: string,
  ): Effect.Effect<ReadonlyArray<CalendarSlotItem>, unknown, unknown> {
    return this._runCalendarSlotQuery(fieldName, this._formFields[fieldName])
  }

  executeCalendarSlotsWithState(
    fieldName: string,
    state: TState,
    ctx: FlowContext<TSteps>,
    item?: TItem,
  ): Effect.Effect<ReadonlyArray<CalendarSlotItem>, unknown, unknown> {
    const fields = this.getFieldsWithState(state, ctx, item)
    return this._runCalendarSlotQuery(fieldName, fields[fieldName])
  }

  /** Encoded authoritative values, without form-initialization placeholders. */
  resolveOriginalValues(
    processState: Record<string, unknown>,
    ctx: FlowContext<TSteps>,
    item?: unknown,
    currentProviderUser?: string,
  ): Effect.Effect<Record<string, unknown>, never> {
    const fields = this.getFieldsWithState(
      processState as TState,
      ctx,
      item as TItem,
    )
    return this.resolveFieldDefaults(
      makeSubmissionSchema(Schema.Struct(fields)).fields,
      currentProviderUser,
    ).pipe(
      Effect.map((defaults) =>
        executableOriginalValues(this.sharedSchema, defaults, processState),
      ),
    )
  }

  resolvePresentation(
    processState: Record<string, unknown>,
    ctx: FlowContext<TSteps>,
    item?: unknown,
  ): Record<string, FormPresentation> {
    const presentation: Record<string, FormPresentation> = {}
    const fields = this.getFieldsWithState(
      processState as TState,
      ctx,
      item as TItem,
    )
    const visit = (fields: Schema.Struct.Fields, prefix: string): void => {
      for (const [name, field] of Object.entries(fields)) {
        const target = prefix ? `${prefix}.${name}` : name
        const label = fieldAnnotation(field.ast, FormLabel)
        const description = fieldAnnotation(field.ast, FormDescription)
        const text =
          fieldAnnotation(field.ast, FormStaticText) ??
          fieldAnnotation(field.ast, TEXTBLOCK_CONTENT_SYMBOL) ??
          fieldAnnotation(field.ast, LINK_TEXT_SYMBOL)
        const href = fieldAnnotation(field.ast, LINK_URL_SYMBOL)
        presentation[target] = {
          ...(typeof label === "string" ? { label } : {}),
          ...(typeof description === "string" ? { description } : {}),
          ...(typeof text === "string" ? { text } : {}),
          ...(typeof href === "string" ? { href } : {}),
        }
        if (field.ast._tag === "Objects")
          visit(
            Object.fromEntries(
              field.ast.propertySignatures.map((property) => [
                String(property.name),
                Schema.make(property.type),
              ]),
            ),
            target,
          )
      }
    }
    visit(fields, "")
    return presentation
  }

  /**
   * Resolves all default values for this Form given the current process state.
   * Re-executes the form function with state to get fields with state-based defaults.
   * Returns flat defaults (wrapper fields are flattened into parent level).
   *
   * @param processState - Current process state
   * @param ctx - Flow context with step metadata
   * @param item - Optional forEach item data for per-instance context
   * @returns Record of field names to their resolved default values (flat)
   */
  resolveDefaults(
    processState: Record<string, unknown>,
    ctx: FlowContext<TSteps>,
    item?: unknown,
    currentProviderUser?: string,
  ): Effect.Effect<Record<string, unknown>, never> {
    return Effect.gen({ self: this }, function* () {
      // Start with schema defaults
      const defaults = this.defaults()

      // Re-execute form function with actual state to get fields with state-based defaults
      const fieldsWithState = this.getFieldsWithState(
        processState as TState,
        ctx,
        item as TItem,
      )
      const resolvedDefaults = yield* this.resolveFieldDefaults(
        fieldsWithState,
        currentProviderUser,
      )

      // Flatten: merge defaults into flat shape using submission schema fields
      const flatDefaults = flattenDefaults(
        mergeFormDefaults(defaults, resolvedDefaults),
        Schema.Struct(
          this._formFields as Schema.Struct.Fields,
        ) as Schema.Struct<Schema.Struct.Fields>,
      )

      return flatDefaults
    })
  }
}

const getAnnotation = (
  ast: SchemaAST.AST,
  key: symbol,
): Option.Option<unknown> => Option.fromNullishOr(fieldAnnotation(ast, key))
