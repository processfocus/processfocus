import type { Schema } from "effect"
import type {
  CalendarSlotCalendarMetadata,
  LinkButtonColor,
  MetricBreakdownBucket,
  MetricBreakdownControl,
  MetricBreakdownField,
  RadioFieldMarker,
  RadioFieldOption,
} from "@pf/form-schema"

export type {
  CalendarSlotCalendarMetadata,
  CalendarSlotItem,
  CalendarSlotWeekday,
  FieldPermissionMetadata,
  LinkButtonColor,
  MetricBreakdownBucket,
  MetricBreakdownColor,
  MetricBreakdownControl,
  MetricBreakdownField,
  MetricBreakdownSelectorControl,
  MetricBreakdownSelectorOption,
  RadioFieldOption,
} from "@pf/form-schema"

export interface ClientFieldPermissionMetadata {
  readonly modify: string
}

/**
 * Enum of supported form component types
 */
export enum FormComponentType {
  Text = "text",
  TextArea = "textarea",
  Number = "number",
  Date = "date",
  Email = "email",
  Phone = "phone",
  ProviderUser = "provider-user",
  Boolean = "boolean",
  Radio = "radio",
  Select = "select",
  File = "file",
  FieldSet = "fieldset",
  List = "list",
  Table = "table",
  Lookup = "lookup",
  CalendarSlot = "calendar-slot",
  MetricBreakdown = "metric-breakdown",
  Plugin = "plugin",
  Static = "static",
  Link = "link",
}

/**
 * Base metadata which all form components share
 */
export interface BaseFormComponent {
  readonly _tag: FormComponentType
  readonly label: string
  readonly description?: string
  readonly readonly?: boolean
  readonly disabled?: boolean
  readonly hidden?: boolean
  readonly required?: boolean
  readonly permission?: ClientFieldPermissionMetadata
}

/**
 * Form components that represents an actual input field
 */
export interface FormField extends BaseFormComponent {
  readonly field: string // Full path like "agree.acceptTerms"
  readonly autoComplete?: string
}

/**
 * Text input field
 */
export interface TextField extends FormField {
  readonly _tag: FormComponentType.Text
}

export interface SelectField extends FormField {
  readonly _tag: FormComponentType.Select
  readonly options: readonly string[]
  /** Encoded value to restore when clearing an optional/nullable choice. */
  readonly emptyValue?: "null" | "undefined"
}

export interface TextAreaField extends FormField {
  readonly _tag: FormComponentType.TextArea
}

/**
 * Number input field
 */
export interface NumberField extends FormField {
  readonly _tag: FormComponentType.Number
}

export interface DateField extends FormField {
  readonly _tag: FormComponentType.Date
}

/**
 * Email input field
 */
export interface EmailField extends FormField {
  readonly _tag: FormComponentType.Email
}

/**
 * Phone input field
 */
export interface PhoneField extends FormField {
  readonly _tag: FormComponentType.Phone
}

export interface ProviderUserField extends FormField {
  readonly _tag: FormComponentType.ProviderUser
}

/**
 * Boolean/checkbox field
 */
export interface BooleanField extends FormField {
  readonly _tag: FormComponentType.Boolean
}

export interface RadioField extends FormField {
  readonly _tag: FormComponentType.Radio
  readonly options: readonly [RadioFieldOption, ...RadioFieldOption[]]
}

/**
 * File upload field.
 * The stored value is a fileId string; the UI handles upload via FileUploadContext.
 */
export interface FileField extends FormField {
  readonly _tag: FormComponentType.File
  readonly documentStore: string
  readonly accept?: string
  readonly maxSize?: number
}

/**
 * Recursive type for form component children
 */
export type FormComponentChildren = Record<string, FormComponent>

/**
 * Regular FieldSet that contributes to path hierarchy
 * Children paths include this FieldSet's name
 */
export interface FieldSet<
  T extends FormComponentChildren = FormComponentChildren,
> extends BaseFormComponent {
  readonly _tag: FormComponentType.FieldSet
  readonly children: T
}

/**
 * Searchable lookup/select field.
 * The frontend uses stepPath + fieldName to call the GraphQL query for suggestions.
 *
 * For dependent lookups, `dependencies` lists the field names this lookup
 * depends on and `queryName` is the generated GraphQL query to call.
 */
export interface LookupField extends FormField {
  readonly _tag: FormComponentType.Lookup
  readonly dependencies?: ReadonlyArray<string>
  readonly queryName?: string
  readonly allowFreeText?: boolean
}

export interface CalendarSlotField extends FormField {
  readonly _tag: FormComponentType.CalendarSlot
  readonly timeZone: string
  readonly locale: string
  readonly calendar?: CalendarSlotCalendarMetadata
  readonly emptyMessageHtml?: string
  readonly loadErrorMessageHtml?: string
}

/**
 * Plugin-provided field carried through the generic PluginField variant.
 * Keeps the discriminated union closed while supporting unlimited plugin types via pluginType.
 */
export interface PluginField extends FormField {
  readonly _tag: FormComponentType.Plugin
  readonly pluginType: string
  readonly pluginData?: unknown
  readonly scripts?: import("./plugin-registry").PluginScript[]
}

/**
 * List/array field whose items are structs.
 * Each item is rendered as a group of child form components.
 */
export interface ListField extends BaseFormComponent {
  readonly _tag: FormComponentType.List
  readonly field: string
  readonly addButtonLabel?: string
  readonly itemChildren: Record<string, FormComponent>
}

/**
 * Read-only tabular display field whose rows are structs.
 */
export interface TableField extends BaseFormComponent {
  readonly _tag: FormComponentType.Table
  readonly field: string
  readonly itemChildren: Record<string, FormComponent>
}

/**
 * Static text display (no input field).
 * Renders as read-only text content without any form input.
 */
export interface StaticText extends BaseFormComponent {
  readonly _tag: FormComponentType.Static
  readonly field: string
  readonly content?: string
}

export interface StaticLink extends Omit<BaseFormComponent, "label"> {
  readonly _tag: FormComponentType.Link
  readonly field: string
  readonly label?: string
  readonly url: string
  readonly text: string
  readonly display?: "button"
  readonly color?: LinkButtonColor
}

export interface MetricBreakdown extends BaseFormComponent {
  readonly _tag: FormComponentType.MetricBreakdown
  readonly field: string
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

/**
 * Union of all form component types
 */
export type FormComponent =
  | TextField
  | TextAreaField
  | NumberField
  | DateField
  | EmailField
  | PhoneField
  | ProviderUserField
  | BooleanField
  | RadioField
  | SelectField
  | FileField
  | LookupField
  | CalendarSlotField
  | FieldSet
  | ListField
  | TableField
  | PluginField
  | StaticText
  | StaticLink
  | MetricBreakdown

/**
 * Helper type that forces TypeScript to evaluate and display the full type
 * instead of showing the mapped type structure
 */
type Prettify<T> = {
  [K in keyof T]: T[K]
} & {}

/**
 * Type-level mapping from Effect Schema.Struct to client form representation
 *
 * Maps each field in the schema to its corresponding form component,
 * preserving exact property names and structure.
 *
 * Only accepts Schema.Struct types.
 */
export type ClientRepresentation<S> =
  S extends Schema.Struct<infer Fields>
    ? Prettify<MapFieldsToComponents<Fields>>
    : never

/**
 * Maps Schema.Struct.Fields to form components
 *
 * Iterates over each field and maps the schema type to the appropriate component
 */
type MapFieldsToComponents<Fields extends Schema.Struct.Fields> = {
  [K in keyof Fields]: MapSchemaToComponent<Fields[K]>
}

/**
 * Maps a single Schema to its form component type
 *
 * Determines the component type based on the schema's decoded (Type) type.
 * All nested structs are treated as regular FieldSets (flattening is
 * only relevant for submission schema).
 */
type MapSchemaToComponent<S> = S extends RadioFieldMarker
  ? RadioField
  : S extends Schema.Literal<infer Values>
    ? Values[number] extends string
      ? SelectField
      : FormComponent
    : S extends Schema.Struct<infer NestedFields>
      ? FieldSet<Prettify<MapFieldsToComponents<NestedFields>>>
      : S extends Schema.Schema<infer A, infer I>
        ? I extends string | null | undefined
          ? TextField | SelectField
          : I extends number | null | undefined
            ? NumberField
            : I extends boolean | null | undefined
              ? BooleanField
              : A extends ReadonlyArray<unknown>
                ? ListField | TableField
                : A extends object
                  ? FieldSet
                  : FormComponent
        : FormComponent
