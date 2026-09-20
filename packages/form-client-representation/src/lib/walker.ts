import { Data, Effect, Match, Option } from "effect"
import * as AST from "effect/SchemaAST"
import {
  type CalendarSlotFieldMetadata,
  FLATTEN_SYMBOL,
  type FileFieldMetadata,
  FormCalendarSlotInput,
  FormDateInput,
  FormDefault,
  FormEmailInput,
  FormFileInput,
  FormListInput,
  FormLookupInput,
  FormNumberInput,
  FormPermission,
  FormPhoneInput,
  FormProviderUserInput,
  FormRadioInput,
  FormReadOnly,
  FormStaticText,
  FormSuggestionInput,
  FormTableInput,
  FormTextAreaInput,
  LINK_COLOR_SYMBOL,
  LINK_DISPLAY_SYMBOL,
  LINK_TEXT_SYMBOL,
  LINK_URL_SYMBOL,
  METRIC_BREAKDOWN_SYMBOL,
  type RadioFieldMetadata,
  STRUCTURAL_ONLY_SYMBOL,
  STRUCTURAL_TYPE_SYMBOL,
  TEXTBLOCK_CONTENT_SYMBOL,
  isFieldPermissionMetadata,
  isListFieldMetadata,
  isMetricBreakdownOptions,
} from "@pf/form-schema"
import { extractAnnotations } from "./extract-annotations"
import { getMatchingPlugin } from "./plugin-registry"
import type {
  BooleanField,
  CalendarSlotField,
  DateField,
  EmailField,
  FieldSet,
  FileField,
  FormComponent,
  ListField,
  LookupField,
  MetricBreakdown,
  NumberField,
  PhoneField,
  PluginField,
  ProviderUserField,
  RadioField,
  StaticLink,
  StaticText,
  TableField,
  TextAreaField,
  TextField,
} from "./types"
import { FormComponentType } from "./types"

/**
 * Error types for walker failures
 */
export class UnknownSchemaFieldTypeError extends Data.TaggedError(
  "UnknownSchemaFieldTypeError",
)<{
  readonly fieldName: string
  readonly schemaType: string
}> {
  override get message() {
    return `Cannot create form field "${this.fieldName}": schema type "${this.schemaType}" is not supported`
  }
}

export class IndexSignaturesNotSupportedError extends Data.TaggedError(
  "IndexSignaturesNotSupportedError",
  // biome-ignore lint/complexity/noBannedTypes: Effect TaggedError pattern
)<{}> {
  override get message() {
    return "Index signatures are not supported in schemas"
  }
}

export class UnrecognizedASTNodeError extends Data.TaggedError(
  "UnrecognizedASTNodeError",
)<{
  readonly nodeTag: string
}> {
  override get message() {
    return `AST node type "${this.nodeTag}" is not recognized`
  }
}

export class InvalidPropertyKeyError extends Data.TaggedError(
  "InvalidPropertyKeyError",
)<{
  readonly propertyKey: PropertyKey
}> {
  override get message() {
    return `Property keys must be strings or numbers, got: ${String(this.propertyKey)}`
  }
}

export class InvalidFieldPermissionError extends Data.TaggedError(
  "InvalidFieldPermissionError",
)<{
  readonly fieldName: string
  readonly reason: string
}> {
  override get message() {
    return `Cannot apply field permission to "${this.fieldName}": ${this.reason}`
  }
}

export class InvalidStaticLinkError extends Data.TaggedError(
  "InvalidStaticLinkError",
)<{
  readonly fieldName: string
  readonly url: unknown
  readonly text: unknown
}> {
  override get message() {
    return `Cannot create link field "${this.fieldName}": url must use http, https, or mailto and text must be a string`
  }
}

/**
 * Union of all walker error types
 */
export type WalkError =
  | UnknownSchemaFieldTypeError
  | IndexSignaturesNotSupportedError
  | UnrecognizedASTNodeError
  | InvalidPropertyKeyError
  | InvalidFieldPermissionError
  | InvalidStaticLinkError

/**
 * Validates that a property key is not a symbol
 * Returns an Effect that fails if the key is a symbol
 */
const validatePropertyKey = (
  propertyKey: PropertyKey,
): Effect.Effect<string, InvalidPropertyKeyError> => {
  if (typeof propertyKey === "symbol") {
    return Effect.fail(new InvalidPropertyKeyError({ propertyKey }))
  }
  return Effect.succeed(String(propertyKey))
}

/**
 * Main walker function that processes Effect Schema AST and emits form structure
 *
 * @param ast - The Effect Schema AST to walk
 * @param parentPath - Current path prefix for building field paths
 */
export const walkAST = (
  ast: AST.AST,
  parentPath = "",
  nestingDepth = 0,
): Effect.Effect<Record<string, FormComponent>, WalkError> =>
  Match.type<AST.AST>().pipe(
    // optionalWith defaults turn a Struct itself into a transformation. The
    // browser still edits its encoded fields; defaults/decoding remain server-side.
    Match.tag("Transformation", (transformation) =>
      walkAST(transformation.from, parentPath, nestingDepth),
    ),
    Match.tag("TypeLiteral", (typeLiteral) =>
      Effect.gen(function* () {
        const result: Record<string, FormComponent> = {}

        // Process each property signature
        for (const prop of typeLiteral.propertySignatures) {
          const fieldName = yield* validatePropertyKey(prop.name)
          const component = yield* processProperty(
            prop,
            parentPath,
            nestingDepth,
          )
          result[fieldName] = component
        }

        // Index signatures are not supported
        if (typeLiteral.indexSignatures.length > 0) {
          return yield* new IndexSignaturesNotSupportedError()
        }

        return result
      }),
    ),
    Match.orElse((node) =>
      Effect.fail(new UnrecognizedASTNodeError({ nodeTag: node._tag })),
    ),
  )(ast)

/**
 * Process a single property signature from the schema
 */
const processProperty = (
  prop: AST.PropertySignature,
  parentPath: string,
  nestingDepth: number,
): Effect.Effect<FormComponent, WalkError> =>
  Effect.gen(function* () {
    const fieldName = yield* validatePropertyKey(prop.name)

    // Merge annotations with property annotations taking precedence over type annotations
    const mergedAnnotations = { ...prop.type.annotations, ...prop.annotations }
    const fieldExcludedFromSubmission = mergedAnnotations[FLATTEN_SYMBOL]
    const fieldPath = fieldExcludedFromSubmission
      ? parentPath
      : parentPath
        ? `${parentPath}.${fieldName}`
        : fieldName

    return yield* processType(
      prop.type,
      prop.annotations,
      fieldName,
      fieldPath,
      prop.isOptional,
      nestingDepth,
    )
  })

const hasModifyPermission = (annotations: AST.Annotations): boolean => {
  return isFieldPermissionMetadata(annotations[FormPermission])
}

const hasDefault = (annotations: AST.Annotations): boolean =>
  annotations[FormDefault] !== undefined

const validatePermissionPlacement = (
  annotations: AST.Annotations,
  fieldName: string,
  isOptional: boolean,
  nestingDepth: number,
): Effect.Effect<void, InvalidFieldPermissionError> => {
  if (!hasModifyPermission(annotations)) return Effect.void

  if (nestingDepth > 0) {
    return Effect.fail(
      new InvalidFieldPermissionError({
        fieldName,
        reason: "permissions are only supported on top-level submitted fields",
      }),
    )
  }

  if (annotations[FormReadOnly] === true) {
    return Effect.fail(
      new InvalidFieldPermissionError({
        fieldName,
        reason: "read-only fields cannot declare modify permissions",
      }),
    )
  }

  if (!isOptional && !hasDefault(annotations)) {
    return Effect.fail(
      new InvalidFieldPermissionError({
        fieldName,
        reason:
          "restricted required fields must either be optional or declare a default value",
      }),
    )
  }

  return Effect.void
}

const rejectPermission = (
  annotations: AST.Annotations,
  fieldName: string,
  reason: string,
): Effect.Effect<void, InvalidFieldPermissionError> =>
  hasModifyPermission(annotations)
    ? Effect.fail(new InvalidFieldPermissionError({ fieldName, reason }))
    : Effect.void

/**
 * Process an AST type node and return the corresponding form component
 */
const processType = (
  type: AST.AST,
  annotations: AST.Annotations,
  fieldName: string,
  fieldPath: string,
  isOptional: boolean,
  nestingDepth: number,
): Effect.Effect<FormComponent, WalkError> => {
  // Merge annotations with property annotations taking precedence over type annotations
  const mergedAnnotations = { ...type.annotations, ...annotations }
  const metadata = extractAnnotations(mergedAnnotations, fieldName)

  if (mergedAnnotations[FormRadioInput]) {
    const radioMeta = mergedAnnotations[FormRadioInput] as RadioFieldMetadata
    return validatePermissionPlacement(
      mergedAnnotations,
      fieldName,
      isOptional,
      nestingDepth,
    ).pipe(
      Effect.as<RadioField>({
        field: fieldPath,
        _tag: FormComponentType.Radio,
        ...metadata,
        options: radioMeta.options,
      }),
    )
  }

  // Check if a registered walker plugin matches these annotations
  const matchedPlugin = getMatchingPlugin(mergedAnnotations)
  if (matchedPlugin) {
    return rejectPermission(
      mergedAnnotations,
      fieldName,
      "plugin field permissions are not supported",
    ).pipe(
      Effect.andThen(
        Effect.succeed<PluginField>({
          field: fieldPath,
          _tag: FormComponentType.Plugin,
          pluginType: matchedPlugin.type,
          pluginData: matchedPlugin.extractData?.(mergedAnnotations),
          ...(matchedPlugin.scripts !== undefined && {
            scripts: matchedPlugin.scripts,
          }),
          ...metadata,
        }),
      ),
    )
  }

  return Match.type<AST.AST>().pipe(
    // String field
    Match.tag("StringKeyword", () => {
      // Static text display (no input field)
      if (typeof mergedAnnotations[FormStaticText] === "string") {
        return rejectPermission(
          mergedAnnotations,
          fieldName,
          "static fields cannot declare permissions",
        ).pipe(
          Effect.andThen(
            Effect.succeed<StaticText>({
              field: fieldPath,
              _tag: FormComponentType.Static,
              ...metadata,
            }),
          ),
        )
      }

      const validPermission = validatePermissionPlacement(
        mergedAnnotations,
        fieldName,
        isOptional,
        nestingDepth,
      )

      if (mergedAnnotations[FormProviderUserInput]) {
        return validPermission.pipe(
          Effect.andThen(
            Effect.succeed<ProviderUserField>({
              field: fieldPath,
              _tag: FormComponentType.ProviderUser,
              ...metadata,
            }),
          ),
        )
      }

      // Lookup/searchable select field
      if (mergedAnnotations[FormLookupInput]) {
        return validPermission.pipe(
          Effect.andThen(
            Effect.succeed<LookupField>({
              field: fieldPath,
              _tag: FormComponentType.Lookup,
              ...metadata,
              ...(mergedAnnotations[FormSuggestionInput] === true && {
                allowFreeText: true,
              }),
            }),
          ),
        )
      }

      if (mergedAnnotations[FormCalendarSlotInput]) {
        const slotMeta = mergedAnnotations[
          FormCalendarSlotInput
        ] as CalendarSlotFieldMetadata
        return validPermission.pipe(
          Effect.andThen(
            Effect.succeed<CalendarSlotField>({
              field: fieldPath,
              _tag: FormComponentType.CalendarSlot,
              ...metadata,
              timeZone: slotMeta.timeZone,
              locale: slotMeta.locale,
              ...(slotMeta.calendar != null && { calendar: slotMeta.calendar }),
              ...(slotMeta.emptyMessageHtml != null && {
                emptyMessageHtml: slotMeta.emptyMessageHtml,
              }),
              ...(slotMeta.loadErrorMessageHtml != null && {
                loadErrorMessageHtml: slotMeta.loadErrorMessageHtml,
              }),
            }),
          ),
        )
      }

      // File upload field
      if (mergedAnnotations[FormFileInput]) {
        const fileMeta = mergedAnnotations[FormFileInput] as FileFieldMetadata
        return validPermission.pipe(
          Effect.andThen(
            Effect.succeed<FileField>({
              field: fieldPath,
              _tag: FormComponentType.File,
              ...metadata,
              documentStore: fileMeta.documentStore,
              ...(fileMeta.accept != null && { accept: fileMeta.accept }),
              ...(fileMeta.maxSize != null && { maxSize: fileMeta.maxSize }),
            }),
          ),
        )
      }

      // Determine field type based on annotations
      let fieldType:
        | FormComponentType.Text
        | FormComponentType.TextArea
        | FormComponentType.Number
        | FormComponentType.Date
        | FormComponentType.Email
        | FormComponentType.Phone
      if (mergedAnnotations[FormTextAreaInput]) {
        fieldType = FormComponentType.TextArea
      } else if (mergedAnnotations[FormDateInput]) {
        fieldType = FormComponentType.Date
      } else if (mergedAnnotations[FormEmailInput]) {
        fieldType = FormComponentType.Email
      } else if (mergedAnnotations[FormPhoneInput]) {
        fieldType = FormComponentType.Phone
      } else if (mergedAnnotations[FormNumberInput]) {
        fieldType = FormComponentType.Number
      } else {
        fieldType = FormComponentType.Text
      }

      return validPermission.pipe(
        Effect.andThen(
          Effect.succeed<
            | TextField
            | TextAreaField
            | NumberField
            | DateField
            | EmailField
            | PhoneField
          >({
            field: fieldPath,
            _tag: fieldType,
            ...metadata,
          }),
        ),
      )
    }),

    // Number field
    Match.tag("NumberKeyword", () =>
      validatePermissionPlacement(
        mergedAnnotations,
        fieldName,
        isOptional,
        nestingDepth,
      ).pipe(
        Effect.andThen(
          Effect.succeed<NumberField>({
            field: fieldPath,
            _tag: FormComponentType.Number,
            ...metadata,
          }),
        ),
      ),
    ),

    Match.tag("Literal", (literal) => {
      if (typeof literal.literal !== "string") {
        return Effect.fail(
          new UnknownSchemaFieldTypeError({ fieldName, schemaType: type._tag }),
        )
      }
      return validatePermissionPlacement(
        mergedAnnotations,
        fieldName,
        isOptional,
        nestingDepth,
      ).pipe(
        Effect.as<FormComponent>({
          ...metadata,
          _tag: FormComponentType.Select,
          field: fieldPath,
          options: [literal.literal],
          ...(isOptional ? { emptyValue: "undefined" as const } : {}),
        }),
      )
    }),

    // Boolean field
    Match.tag("BooleanKeyword", () =>
      validatePermissionPlacement(
        mergedAnnotations,
        fieldName,
        isOptional,
        nestingDepth,
      ).pipe(
        Effect.andThen(
          Effect.succeed<BooleanField>({
            field: fieldPath,
            _tag: FormComponentType.Boolean,
            ...metadata,
          }),
        ),
      ),
    ),

    // Nested struct (always treated as a FieldSet)
    Match.tag("TypeLiteral", (typeLiteral) =>
      rejectPermission(
        mergedAnnotations,
        fieldName,
        "wrapper-level and fieldset-level permissions are not supported",
      ).pipe(
        Effect.andThen(
          walkAST(typeLiteral, fieldPath, nestingDepth + 1).pipe(
            Effect.map(
              (children): FieldSet => ({
                _tag: FormComponentType.FieldSet,
                ...metadata,
                children,
              }),
            ),
          ),
        ),
      ),
    ),

    // Array/list field: Schema.Array produces TupleType with rest: [Type(itemAST)]
    Match.tag("TupleType", (tuple) => {
      const restType = tuple.rest[0]
      const listMetadata = mergedAnnotations[FormListInput]
      if (!restType) {
        return Effect.fail(
          new UnknownSchemaFieldTypeError({
            fieldName,
            schemaType: "TupleType (empty)",
          }),
        )
      }
      // rest[0] is an AST.Type wrapper; unwrap to get the actual AST node
      return rejectPermission(
        mergedAnnotations,
        fieldName,
        "list permissions are not supported",
      ).pipe(
        Effect.andThen(
          walkAST(restType.type, fieldPath, nestingDepth + 1).pipe(
            Effect.map((itemChildren): ListField | TableField => ({
              _tag: mergedAnnotations[FormTableInput]
                ? FormComponentType.Table
                : FormComponentType.List,
              field: fieldPath,
              ...metadata,
              ...(isListFieldMetadata(listMetadata) &&
                listMetadata.addButtonLabel !== undefined && {
                  addButtonLabel: listMetadata.addButtonLabel,
                }),
              itemChildren,
            })),
          ),
        ),
      )
    }),

    // Refinement: unwrap to base type, preserve annotations
    // Refinement annotations take precedence over property annotations
    Match.tag("Refinement", (refinement) =>
      processType(
        refinement.from,
        { ...annotations, ...refinement.annotations },
        fieldName,
        fieldPath,
        isOptional,
        nestingDepth,
      ),
    ),

    // Transformation: use .from (input side), merge annotations
    // Transformation annotations take precedence over property annotations
    Match.tag("Transformation", (transformation) =>
      processType(
        transformation.from,
        { ...annotations, ...transformation.annotations },
        fieldName,
        fieldPath,
        isOptional,
        nestingDepth,
      ),
    ),

    // Union: handle NullOr/NullishOr/UndefinedOr patterns
    // Unwrap the non-null/undefined member and process it
    Match.tag("Union", (union) => {
      // Filter out Literal(null) and UndefinedKeyword members
      const nonNullMembers = union.types.filter(
        (t) =>
          !(t._tag === "Literal" && t.literal === null) &&
          t._tag !== "UndefinedKeyword",
      )

      const emptyValue = union.types.some(
        (member) => member._tag === "Literal" && member.literal === null,
      )
        ? "null"
        : isOptional ||
            union.types.some((member) => member._tag === "UndefinedKeyword")
          ? "undefined"
          : undefined

      // If exactly one non-null member, unwrap and process it
      if (nonNullMembers.length === 1 && nonNullMembers[0]) {
        return processType(
          nonNullMembers[0],
          { ...annotations, ...union.annotations },
          fieldName,
          fieldPath,
          isOptional,
          nestingDepth,
        ).pipe(
          Effect.map(
            (component): FormComponent =>
              component._tag === FormComponentType.Select &&
              emptyValue !== undefined
                ? { ...component, emptyValue }
                : component,
          ),
        )
      }

      const options = nonNullMembers.flatMap((member) =>
        member._tag === "Literal" && typeof member.literal === "string"
          ? [member.literal]
          : [],
      )
      if (options.length > 0 && options.length === nonNullMembers.length) {
        return validatePermissionPlacement(
          mergedAnnotations,
          fieldName,
          isOptional,
          nestingDepth,
        ).pipe(
          Effect.as<FormComponent>({
            ...metadata,
            _tag: FormComponentType.Select,
            field: fieldPath,
            options,
            ...(emptyValue !== undefined ? { emptyValue } : {}),
          }),
        )
      }

      // Other multi-member unions remain unsupported
      return Effect.fail(
        new UnknownSchemaFieldTypeError({
          fieldName,
          schemaType: type._tag,
        }),
      )
    }),

    // Undefined keyword: check if it's a structural-only element (TextBlock, Divider, etc.)
    Match.tag("UndefinedKeyword", () => {
      // Check if this is a structural-only element
      const structuralAnnotation = AST.getAnnotation(
        type,
        STRUCTURAL_ONLY_SYMBOL,
      )
      if (Option.isSome(structuralAnnotation)) {
        return rejectPermission(
          mergedAnnotations,
          fieldName,
          "structural-only fields cannot declare permissions",
        ).pipe(
          Effect.andThen(() => {
            const structuralTypeAnnotation = AST.getAnnotation(
              type,
              STRUCTURAL_TYPE_SYMBOL,
            )
            const structuralType = Option.getOrUndefined(
              structuralTypeAnnotation,
            )

            if (structuralType === "metric-breakdown") {
              const metricAnnotation = AST.getAnnotation(
                type,
                METRIC_BREAKDOWN_SYMBOL,
              )
              const options = Option.getOrUndefined(metricAnnotation)

              if (isMetricBreakdownOptions(options)) {
                return Effect.succeed<MetricBreakdown>({
                  field: fieldPath,
                  _tag: FormComponentType.MetricBreakdown,
                  label: metadata.label,
                  readonly: true,
                  title: options.title,
                  buckets: options.buckets,
                  ...(options.badge !== undefined && { badge: options.badge }),
                  ...(options.currency !== undefined && {
                    currency: options.currency,
                  }),
                  ...(options.fields !== undefined && {
                    fields: options.fields,
                  }),
                  ...(options.controls !== undefined && {
                    controls: options.controls,
                  }),
                  ...(options.contextFields !== undefined && {
                    contextFields: options.contextFields,
                  }),
                  ...(options.dataSource !== undefined && {
                    dataSource: options.dataSource,
                  }),
                  ...(options.rendererPluginType !== undefined && {
                    rendererPluginType: options.rendererPluginType,
                  }),
                  ...(options.rendererPluginData !== undefined && {
                    rendererPluginData: options.rendererPluginData,
                  }),
                })
              }
            }

            if (structuralType === "link") {
              const url = mergedAnnotations[LINK_URL_SYMBOL]
              const text = mergedAnnotations[LINK_TEXT_SYMBOL]
              const display = mergedAnnotations[LINK_DISPLAY_SYMBOL]
              const color = mergedAnnotations[LINK_COLOR_SYMBOL]
              const isButtonLink = display === "button"

              if (
                typeof url === "string" &&
                /^(https?:|mailto:)/.test(url) &&
                typeof text === "string"
              ) {
                return Effect.succeed<StaticLink>({
                  field: fieldPath,
                  _tag: FormComponentType.Link,
                  readonly: true,
                  url,
                  text,
                  ...(isButtonLink ? { display } : { label: metadata.label }),
                  ...(color === "blue" ? { color } : {}),
                })
              }

              return Effect.fail(
                new InvalidStaticLinkError({ fieldName: fieldPath, url, text }),
              )
            }

            const contentAnnotation = AST.getAnnotation(
              type,
              TEXTBLOCK_CONTENT_SYMBOL,
            )
            const content = Option.getOrUndefined(contentAnnotation)

            return Effect.succeed({
              field: fieldPath,
              _tag: FormComponentType.Static,
              label: metadata.label,
              description: metadata.description,
              readonly: true,
              content,
            } as StaticText)
          }),
        )
      }
      // Regular undefined field - not supported
      return Effect.fail(
        new UnknownSchemaFieldTypeError({
          fieldName,
          schemaType: type._tag,
        }),
      )
    }),

    // Unsupported type
    Match.orElse(() =>
      Effect.fail(
        new UnknownSchemaFieldTypeError({
          fieldName,
          schemaType: type._tag,
        }),
      ),
    ),
  )(type)
}
