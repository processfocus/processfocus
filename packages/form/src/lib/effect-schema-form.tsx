"use client"

import type { StandardSchemaV1 } from "@standard-schema/spec"
import { useStore } from "@tanstack/react-form"
import { Schema, SchemaAST } from "effect"
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import {
  type CalendarSlotCalendarMetadata,
  FormAutoFocus,
  FormCalendarSlotInput,
  FormCheckboxGroupInput,
  FormComponentPluginType,
  FormDateInput,
  FormDescription,
  FormEmailInput,
  FormLabel,
  FormListInput,
  FormLocalDateTimeInput,
  FormLookupInput,
  FormNumberInput,
  FormPluginData,
  FormRadioInput,
  type FormRequestData,
  FormStaticText,
  FormSuggestionInput,
  FormTextAreaInput,
  LINK_TEXT_SYMBOL,
  LINK_URL_SYMBOL,
  STRUCTURAL_TYPE_SYMBOL,
  TEXTBLOCK_CONTENT_SYMBOL,
  fieldAnnotation,
  hasFlattenAnnotation,
  hasStructuralOnlyAnnotation,
  isListFieldMetadata,
  isReadOnlyField,
} from "@pf/form-schema"
import {
  executableFields,
  getSchemaDefaults,
  prepareExecutableSubmission,
  submissionSchemaSync,
} from "@pf/form-submission-schema"
import {
  CalendarSlotField,
  type CalendarSlotFieldItem,
  DateField,
  LocalDateTimeInput,
  fieldContext,
  formContext,
  normalizeDateFieldValue,
  useAppForm,
  validateDateField,
} from "@pf/shadcn-components"
import { useLocalStorage } from "../hooks/use-local-storage"
import type { FormActionsContext } from "./form-actions"
import { FormPrefill } from "./form-prefill"
import { focusFirstEditableControl } from "./initial-focus"
import { type LookupOptions, useLookup } from "./lookup-context"
import { RegisteredPluginField } from "./registered-plugin-field"
import { SchemaLookup } from "./schema-lookup"
import { type LocalLookupCache, SchemaTypeahead } from "./schema-typeahead"
import { customValidationLogic } from "./validation-logic"

export type BrowserFormSchema = Schema.Struct<
  Record<string, Schema.Codec<unknown, unknown>>
>
const literalChoices = (ast: SchemaAST.AST): string[] =>
  ast._tag === "Union"
    ? ast.types.flatMap(literalChoices)
    : ast._tag === "Literal" && typeof ast.literal === "string"
      ? [ast.literal]
      : []

type SubmissionError = { readonly field: string; readonly message: string }

export function EffectSchemaForm({
  schema,
  stepPath,
  lookupOptions,
  requestData,
  draftId,
  defaultValues,
  readOnlyCheckboxFields,
  pluginConfiguration = {},
  onDraftChange,
  onSubmit,
  children,
}: {
  stepPath?: string | undefined
  lookupOptions?: LookupOptions | undefined
  schema: BrowserFormSchema
  requestData?: FormRequestData | null | undefined
  draftId?: string | undefined
  pluginConfiguration?: Readonly<Record<string, unknown>>
  defaultValues: Record<string, unknown>
  readOnlyCheckboxFields?: readonly string[]
  onDraftChange?: (
    values: Record<string, unknown>,
    clearLocalStorage: () => void,
  ) => void
  onSubmit: (
    values: Record<string, unknown>,
  ) => Promise<ReadonlyArray<SubmissionError> | undefined>
  children: (
    context: FormActionsContext,
    validator: StandardSchemaV1,
  ) => ReactNode
}) {
  const [prefillReady, setPrefillReady] = useState<string | undefined>()
  const readyRef = useRef<string | undefined>(undefined)
  const onReady = useCallback((value: string | undefined) => {
    readyRef.current = value
    setPrefillReady(value)
  }, [])
  const formRef = useRef<HTMLFormElement>(null)
  const unmatchedLookups = useRef(new Set<string>())
  const localLookupCache = useRef<LocalLookupCache>(new Map())
  const [lookupRevision, setLookupRevision] = useState(0)
  const autoFocus = fieldAnnotation(schema.ast, FormAutoFocus) !== false
  useEffect(() => {
    const formElement = formRef.current
    if (!formElement) return
    return focusFirstEditableControl(formElement)
  }, [])
  const hasSubmittedSuccessfully = useRef(false)
  const [savedValues, setSavedValues, clearLocalStorage] = useLocalStorage<
    Record<string, unknown>
  >(draftId, {})
  const [initialValues] = useState(() => {
    const schemaDefaults: Record<string, unknown> = getSchemaDefaults(
      schema.fields,
    )
    return Object.fromEntries(
      Object.entries({ ...defaultValues, ...savedValues }).map(
        ([key, value]) => {
          // Older defaults stored untouched checkboxes as empty strings.
          if (value === "" && schemaDefaults[key] === false) {
            const fallback = defaultValues[key]
            return [key, typeof fallback === "boolean" ? fallback : false]
          }
          return [
            key,
            schema.fields[key] &&
            fieldAnnotation(schema.fields[key].ast, FormDateInput) !== undefined
              ? normalizeDateFieldValue(value)
              : value,
          ]
        },
      ),
    )
  })
  const focusFirstError = () => {
    requestAnimationFrame(() => {
      const input = formRef.current?.querySelector<HTMLElement>(
        '[aria-invalid="true"], [data-invalid-plugin="true"] :is(input:not([type="hidden"]):not([readonly]), textarea:not([readonly]), select, button, [tabindex]):not([disabled]):not([tabindex="-1"])',
      )
      input?.focus()
      input?.scrollIntoView({ behavior: "smooth", block: "center" })
    })
  }
  const validator = useMemo((): StandardSchemaV1<
    Record<string, unknown>,
    Record<string, unknown>
  > => {
    const base = Schema.toStandardSchemaV1(submissionSchemaSync(schema))
    return {
      "~standard": {
        version: 1,
        vendor: "processfocus",
        validate: (input) => {
          if (
            typeof input !== "object" ||
            input === null ||
            Array.isArray(input)
          )
            return { issues: [{ message: "Expected form values" }] }
          const values = Object.fromEntries(Object.entries(input))
          const prepared = prepareExecutableSubmission(
            schema,
            values,
            requestData?.originalValues ?? {},
            requestData?.inaccessible,
          )
          const result = base["~standard"].validate(prepared.values)
          if (result instanceof Promise)
            throw new Error("Browser form checks must be synchronous")
          const hidden = [
            ...(requestData?.inaccessible ?? []),
            ...executableFields(schema, values, requestData?.inaccessible)
              .filter((field) => field.state.hidden)
              .map((field) => field.path.join(".")),
          ]
          const issues = [
            ...prepared.errors.map((error) => ({
              message: error.message,
              path: error.field.split("."),
            })),
            ...(result.issues ?? []).filter(
              (issue) =>
                !hidden.some((path) => {
                  const field = issue.path
                    ?.map((segment) =>
                      typeof segment === "object" ? segment.key : segment,
                    )
                    .join(".")
                  return field === path || field?.startsWith(`${path}.`)
                }),
            ),
          ]
          return issues.length ? { issues } : { value: prepared.values }
        },
      },
    }
  }, [schema, requestData?.originalValues, requestData?.inaccessible])
  const [serverErrors, setServerErrors] = useState<
    ReadonlyArray<SubmissionError>
  >([])
  const form = useAppForm({
    defaultValues: initialValues,
    validators: { onDynamic: validator },
    validationLogic: customValidationLogic,
    onSubmit: async ({ value }) => {
      if (
        requestData?.prefill &&
        readyRef.current !== value[requestData.prefill.dependency]
      ) {
        setServerErrors([
          { field: "", message: "Load the saved values before submitting." },
        ])
        return
      }
      // TanStack retains input values; Standard Schema's decoded output is validation only.
      const prepared = prepareExecutableSubmission(
        schema,
        value,
        requestData?.originalValues ?? {},
        requestData?.inaccessible,
      )
      for (const field of requestData?.inaccessible ?? [])
        delete prepared.values[field]
      const errors = (await onSubmit(prepared.values)) ?? []
      setServerErrors(errors)
      for (const error of errors) {
        if (error.field)
          form.setFieldMeta(error.field, (meta) => ({
            ...meta,
            errorMap: { ...meta.errorMap, onSubmit: error.message },
          }))
      }
      if (errors.length > 0) {
        setLookupRevision((revision) => revision + 1)
        focusFirstError()
      } else {
        hasSubmittedSuccessfully.current = true
        clearLocalStorage()
      }
    },
    onSubmitInvalid: focusFirstError,
    listeners: {
      onChange: ({ formApi }) => {
        setServerErrors([])
        if (!hasSubmittedSuccessfully.current) {
          setSavedValues(formApi.state.values)
          onDraftChange?.(formApi.state.values, clearLocalStorage)
        }
      },
    },
  })

  const submissionAttempts = useStore(
    form.store,
    (state) => state.submissionAttempts,
  )

  const renderFields = (
    ast: SchemaAST.AST,
    values: Record<string, unknown>,
    prefix = "",
    targetPrefix = "",
    inheritedDisabled = false,
  ): ReactNode => {
    const states = executableFields(schema, values, requestData?.inaccessible)
    if (ast._tag !== "Objects")
      throw new Error("Browser form groups must be structs")
    return ast.propertySignatures.map((property) => {
      const fieldSchema = Schema.make(property.type)
      const path = prefix
        ? `${prefix}.${String(property.name)}`
        : String(property.name)
      const target = targetPrefix
        ? `${targetPrefix}.${String(property.name)}`
        : String(property.name)
      const state = states.find(
        (field) => field.target.join(".") === target,
      )?.state
      if (
        state?.hidden ||
        requestData?.inaccessible.some(
          (field) => path === field || path.startsWith(`${field}.`),
        )
      )
        return null
      const presentation = requestData?.presentation[target]
      if (requestData?.prefill?.concealed.includes(path)) return null
      const labelAnnotation =
        presentation?.label ??
        fieldAnnotation(property.type, FormLabel) ??
        fieldAnnotation(property.type, "title")
      const label =
        state?.label ??
        (typeof labelAnnotation === "string"
          ? labelAnnotation
          : (SchemaAST.resolveTitle(property.type) ?? String(property.name)))
      const description =
        presentation?.description ??
        fieldAnnotation(property.type, FormDescription) ??
        fieldAnnotation(property.type, "description")
      if (hasStructuralOnlyAnnotation(fieldSchema)) {
        const text =
          presentation?.text ??
          fieldAnnotation(property.type, FormStaticText) ??
          fieldAnnotation(property.type, TEXTBLOCK_CONTENT_SYMBOL) ??
          fieldAnnotation(property.type, LINK_TEXT_SYMBOL)
        const href =
          presentation?.href ?? fieldAnnotation(property.type, LINK_URL_SYMBOL)
        if (
          fieldAnnotation(property.type, STRUCTURAL_TYPE_SYMBOL) === "text-list"
        ) {
          if (typeof text !== "string" || !text.trim()) return null
          const items = text.trim().split(/\r?\n\r?\n/)
          return (
            <section key={path} className="space-y-2">
              <h3 className="font-semibold">{label}</h3>
              <ul className="list-disc space-y-2 ps-5">
                {items.map((item, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: static display items
                  <li key={index} className="whitespace-pre-line break-words">
                    {item}
                  </li>
                ))}
              </ul>
            </section>
          )
        }
        return typeof text === "string" ? (
          typeof href === "string" && href ? (
            <a key={path} href={href}>
              {text}
            </a>
          ) : (
            <p key={path}>{text}</p>
          )
        ) : null
      }
      const plugin = fieldAnnotation(property.type, FormComponentPluginType)
      if (
        typeof plugin === "object" &&
        plugin !== null &&
        "type" in plugin &&
        typeof plugin.type === "string"
      ) {
        const pluginType = plugin.type
        const staticData = fieldAnnotation(property.type, FormPluginData)
        const runtimeData = pluginConfiguration[path]
        const pluginData = {
          ...(typeof staticData === "object" && staticData !== null
            ? staticData
            : {}),
          ...(typeof runtimeData === "object" && runtimeData !== null
            ? runtimeData
            : {}),
        }
        return (
          <form.Field key={path} name={path}>
            {(field) => {
              const showErrors =
                submissionAttempts > 0 ||
                (field.state.meta.isTouched && !field.state.meta.isDefaultValue)
              const errors = !showErrors
                ? []
                : [
                    ...field.state.meta.errors.map((error) =>
                      typeof error === "string"
                        ? error
                        : (error?.message ?? "Invalid value"),
                    ),
                    ...serverErrors
                      .filter((error) => error.field === path)
                      .map((error) => error.message),
                  ]
              return (
                <div data-invalid-plugin={errors.length > 0}>
                  <RegisteredPluginField
                    form={{ AppField: form.Field, Subscribe: form.Subscribe }}
                    field={{
                      _tag: "plugin",
                      field: path,
                      label,
                      pluginType,
                      readonly: isReadOnlyField(fieldSchema),
                      ...(typeof description === "string" && { description }),
                      pluginData,
                    }}
                    options={stepPath === undefined ? {} : { stepPath }}
                  />
                  <div role="alert" className="text-sm text-rose-600">
                    {errors.join(" ")}
                  </div>
                </div>
              )
            }}
          </form.Field>
        )
      }
      const checkboxAnnotation = fieldAnnotation(
        property.type,
        FormCheckboxGroupInput,
      )
      if (checkboxAnnotation !== undefined) {
        const metadata = Schema.decodeUnknownSync(
          Schema.Struct({
            options: Schema.Array(
              Schema.Struct({
                value: Schema.String,
                label: Schema.String,
                description: Schema.optional(Schema.String),
              }),
            ),
          }),
        )(checkboxAnnotation)
        return (
          <form.Field key={path} name={path}>
            {(field) => {
              const selected = Schema.decodeUnknownSync(
                Schema.Array(Schema.String),
              )(field.state.value ?? [])
              const options = [
                ...new Map(
                  metadata.options.map((option) => [option.value, option]),
                ).values(),
              ]
              const unavailable = [...new Set(selected)].filter(
                (value) => !options.some((option) => option.value === value),
              )
              const errors =
                submissionAttempts > 0 ||
                (field.state.meta.isTouched && !field.state.meta.isDefaultValue)
                  ? field.state.meta.errors.map((error) =>
                      typeof error === "string"
                        ? error
                        : (error?.message ?? "Invalid value"),
                    )
                  : []
              return (
                <fieldset
                  className="space-y-2"
                  tabIndex={
                    options.length + unavailable.length === 0 ? -1 : undefined
                  }
                  aria-invalid={
                    options.length + unavailable.length === 0 &&
                    errors.length > 0
                      ? true
                      : undefined
                  }
                  disabled={
                    inheritedDisabled ||
                    state?.disabled === true ||
                    isReadOnlyField(fieldSchema) ||
                    Boolean(
                      requestData?.prefill?.fields.includes(path) &&
                        prefillReady !== values[requestData.prefill.dependency],
                    )
                  }
                >
                  <legend className="text-sm font-medium">{label}</legend>
                  <p
                    id={`${path}-description`}
                    className="text-sm text-slate-500"
                  >
                    {typeof description === "string" ? description : null}
                  </p>
                  {[
                    ...options,
                    ...unavailable.map((value) => ({
                      value,
                      label: `${value} (unavailable)`,
                      description:
                        "This selection is no longer available. Uncheck to remove it.",
                    })),
                  ].map((option) => (
                    <label
                      key={option.value}
                      className="flex items-start gap-2"
                    >
                      <input
                        type="checkbox"
                        name={path}
                        value={option.value}
                        checked={selected.includes(option.value)}
                        aria-invalid={errors.length > 0}
                        aria-describedby={`${path}-description ${path}-errors`}
                        onBlur={field.handleBlur}
                        onChange={(event) => {
                          setServerErrors([])
                          field.handleChange(
                            event.target.checked
                              ? [...new Set([...selected, option.value])]
                              : selected.filter(
                                  (value) => value !== option.value,
                                ),
                          )
                        }}
                      />
                      <span>
                        <span className="block font-medium">
                          {option.label}
                        </span>
                        <span className="block text-sm text-slate-500">
                          {option.description}
                        </span>
                      </span>
                    </label>
                  ))}
                  <div
                    id={`${path}-errors`}
                    role="alert"
                    className="text-sm text-rose-600"
                  >
                    {errors.join(" ")}
                  </div>
                </fieldset>
              )
            }}
          </form.Field>
        )
      }
      const boolean =
        property.type._tag === "Boolean" ||
        (property.type._tag === "Union" &&
          property.type.types.some((member) => member._tag === "Boolean"))
      const readOnly = isReadOnlyField(fieldSchema)
      if (readOnly && !(boolean && readOnlyCheckboxFields?.includes(path))) {
        let value: unknown = defaultValues
        for (const part of path.split("."))
          value =
            typeof value === "object" && value !== null
              ? Reflect.get(value, part)
              : undefined
        return (
          <fieldset
            key={path}
            className={
              Array.isArray(value) || label === ""
                ? "space-y-1"
                : "grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] items-baseline gap-x-4"
            }
          >
            {label !== "" && (
              <label
                htmlFor={path}
                className="font-medium text-muted-foreground"
              >
                {label}
              </label>
            )}
            {Array.isArray(value) ? (
              value.length === 0 ? (
                <p className="text-slate-400 dark:text-slate-500">&mdash;</p>
              ) : (
                <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                  {value.map((item, index) => (
                    // Read-only display rows never reorder; the position is
                    // the only stable identity for repeated line entries.
                    // biome-ignore lint/suspicious/noArrayIndexKey: static rows
                    <li key={index} className="whitespace-pre-wrap py-1">
                      {String(item ?? "")}
                    </li>
                  ))}
                </ul>
              )
            ) : fieldAnnotation(property.type, FormTextAreaInput) ? (
              <p id={path} className="whitespace-pre-line break-words">
                {String(value ?? "")}
              </p>
            ) : (
              <input
                id={path}
                readOnly
                value={String(value ?? "")}
                className="min-w-0 w-full border-0 bg-transparent"
              />
            )}
          </fieldset>
        )
      }
      if (property.type._tag === "Objects") {
        return (
          <fieldset key={path} className="space-y-4">
            {typeof labelAnnotation === "string" && (
              <legend className="font-semibold">{label}</legend>
            )}
            {renderFields(
              property.type,
              values,
              hasFlattenAnnotation(fieldSchema) ? prefix : path,
              target,
              inheritedDisabled || state?.disabled === true,
            )}
          </fieldset>
        )
      }
      if (property.type._tag === "Arrays") {
        const item = property.type.rest[0]
        if (item?._tag !== "Objects")
          throw new Error("Browser form lists must contain structs")
        const metadata = fieldAnnotation(property.type, FormListInput)
        const emptyItem = () =>
          getSchemaDefaults(
            Object.fromEntries(
              item.propertySignatures.map((property) => [
                String(property.name),
                Schema.make(property.type),
              ]),
            ),
          )
        return (
          <form.Field key={path} name={path} mode="array">
            {(field) => (
              <ExecutableList
                label={label}
                addButtonLabel={
                  isListFieldMetadata(metadata)
                    ? metadata.addButtonLabel
                    : undefined
                }
                count={
                  Array.isArray(field.state.value)
                    ? field.state.value.length
                    : 0
                }
                disabled={inheritedDisabled || state?.disabled === true}
                onAdd={() =>
                  field.handleChange([
                    ...(Array.isArray(field.state.value)
                      ? field.state.value
                      : []),
                    emptyItem(),
                  ])
                }
                onRemove={(index) => field.removeValue(index)}
                renderItem={(index) =>
                  renderFields(
                    item,
                    values,
                    `${path}[${index}]`,
                    target,
                    inheritedDisabled || state?.disabled === true,
                  )
                }
              />
            )}
          </form.Field>
        )
      }
      const encoded = SchemaAST.toEncoded(property.type)
      const choices = literalChoices(encoded)
      const calendarAnnotation = fieldAnnotation(
        property.type,
        FormCalendarSlotInput,
      )
      const calendar =
        calendarAnnotation === undefined
          ? undefined
          : Schema.decodeUnknownSync(
              Schema.Struct({
                timeZone: Schema.String,
                locale: Schema.String,
                emptyMessageHtml: Schema.optional(Schema.String),
                loadErrorMessageHtml: Schema.optional(Schema.String),
                calendar: Schema.optional(
                  Schema.Struct({
                    weekStartsOn: Schema.optional(
                      Schema.Literals([0, 1, 2, 3, 4, 5, 6]),
                    ),
                    businessDays: Schema.optional(
                      Schema.Array(Schema.Literals([0, 1, 2, 3, 4, 5, 6])),
                    ),
                  }),
                ),
              }),
            )(calendarAnnotation)
      const radioAnnotation = fieldAnnotation(property.type, FormRadioInput)
      const radio =
        radioAnnotation === undefined
          ? undefined
          : Schema.decodeUnknownSync(
              Schema.Struct({
                options: Schema.Array(
                  Schema.Struct({ value: Schema.String, label: Schema.String }),
                ),
              }),
            )(radioAnnotation)
      const numeric =
        fieldAnnotation(property.type, FormNumberInput) !== undefined
      const lookup =
        fieldAnnotation(property.type, FormLookupInput) !== undefined
      const date = fieldAnnotation(property.type, FormDateInput) !== undefined
      const localDateTime =
        fieldAnnotation(property.type, FormLocalDateTimeInput) === true
      const email = fieldAnnotation(property.type, FormEmailInput) !== undefined
      const textArea =
        fieldAnnotation(property.type, FormTextAreaInput) !== undefined
      const disabled =
        inheritedDisabled ||
        state?.disabled === true ||
        Boolean(
          requestData?.prefill?.fields.includes(path) &&
            prefillReady !== values[requestData.prefill.dependency],
        )
      if (date) {
        return (
          <form.AppField
            key={path}
            name={path}
            validators={{
              onDynamic: ({ value }) =>
                disabled ? undefined : validateDateField({ value }),
            }}
          >
            {() => <DateField label={label} readOnly={disabled} />}
          </form.AppField>
        )
      }
      const lookupField = prefix.includes("[") ? String(property.name) : path
      const lookupMetadata = fieldAnnotation(property.type, FormLookupInput)
      if (
        lookup &&
        stepPath &&
        typeof lookupMetadata === "object" &&
        lookupMetadata !== null &&
        "mode" in lookupMetadata &&
        (lookupMetadata.mode === "server" || lookupMetadata.mode === "local")
      ) {
        return (
          <form.AppField
            key={path}
            name={path}
            validators={{
              onDynamic: () =>
                !disabled && unmatchedLookups.current.has(path)
                  ? { message: "Select an option from the suggestions." }
                  : undefined,
            }}
          >
            {() => (
              <SchemaTypeahead
                stepPath={stepPath}
                field={lookupField}
                label={label}
                disabled={disabled}
                options={lookupOptions}
                binding={requestData?.lookups?.[path]}
                values={values}
                local={
                  lookupMetadata.mode === "local" &&
                  "maxItems" in lookupMetadata &&
                  typeof lookupMetadata.maxItems === "number"
                    ? {
                        maxItems: lookupMetadata.maxItems,
                        cache: localLookupCache.current,
                        revision: lookupRevision,
                      }
                    : undefined
                }
                emptyValue={
                  property.type.context?.isOptional
                    ? undefined
                    : encoded._tag === "Union" &&
                        encoded.types.some((member) => member._tag === "Null")
                      ? null
                      : ""
                }
                onUnmatchedChange={(unmatched) => {
                  if (unmatched) unmatchedLookups.current.add(path)
                  else unmatchedLookups.current.delete(path)
                }}
              />
            )}
          </form.AppField>
        )
      }
      if (lookup && stepPath) {
        const freeText =
          fieldAnnotation(property.type, FormSuggestionInput) === true
        const emptyValue = property.type.context?.isOptional
          ? undefined
          : encoded._tag === "Union" &&
              encoded.types.some((member) => member._tag === "Null")
            ? null
            : ""
        return (
          <form.AppField
            key={path}
            name={path}
            validators={{
              onDynamic: ({ value }) =>
                !disabled &&
                !freeText &&
                (unmatchedLookups.current.has(path) ||
                  (emptyValue === "" && !value))
                  ? { message: "Select an option from the suggestions." }
                  : undefined,
            }}
          >
            {() => (
              <SchemaLookup
                stepPath={stepPath}
                field={lookupField}
                allowFreeText={freeText}
                emptyValue={emptyValue}
                onUnmatchedChange={(unmatched) => {
                  if (unmatched) unmatchedLookups.current.add(path)
                  else unmatchedLookups.current.delete(path)
                }}
                binding={requestData?.lookups?.[path]}
                values={values}
                options={lookupOptions}
                label={label}
                disabled={disabled}
              />
            )}
          </form.AppField>
        )
      }
      return (
        <form.Field key={path} name={path}>
          {(field) => {
            const showErrors =
              submissionAttempts > 0 ||
              (field.state.meta.isTouched && !field.state.meta.isDefaultValue)
            const errors = !showErrors
              ? []
              : [
                  ...field.state.meta.errors.map((error) =>
                    choices.length > 0 && field.state.value === ""
                      ? "This field is required."
                      : typeof error === "string"
                        ? error
                        : (error?.message ?? "Invalid value"),
                  ),
                ]
            return (
              <div className="space-y-1">
                {!calendar && !boolean && !localDateTime && (
                  <label htmlFor={path} className="block text-sm font-medium">
                    {label}
                  </label>
                )}
                {calendar && stepPath ? (
                  <formContext.Provider value={form}>
                    <fieldContext.Provider value={field}>
                      <ExecutableCalendar
                        formRef={formRef}
                        stepPath={stepPath}
                        path={path}
                        options={lookupOptions}
                        metadata={calendar}
                        label={label}
                        description={
                          typeof description === "string"
                            ? description
                            : undefined
                        }
                        disabled={disabled}
                      />
                    </fieldContext.Provider>
                  </formContext.Provider>
                ) : localDateTime ? (
                  <LocalDateTimeInput
                    id={path}
                    label={label}
                    value={
                      typeof field.state.value === "string"
                        ? field.state.value
                        : ""
                    }
                    disabled={disabled}
                    required={state?.required === true}
                    invalid={errors.length > 0}
                    describedBy={`${path}-description ${path}-errors`}
                    onBlur={field.handleBlur}
                    onChange={field.handleChange}
                  />
                ) : radio ? (
                  <div
                    role="radiogroup"
                    aria-label={label}
                    aria-describedby={`${path}-description ${path}-errors`}
                  >
                    {radio.options.map((option) => (
                      <label
                        key={option.value}
                        className="flex items-center gap-2"
                      >
                        <input
                          type="radio"
                          name={path}
                          value={option.value}
                          checked={field.state.value === option.value}
                          disabled={disabled}
                          aria-invalid={errors.length > 0}
                          onBlur={field.handleBlur}
                          onChange={() => {
                            setServerErrors([])
                            field.handleChange(option.value)
                          }}
                        />
                        {option.label}
                      </label>
                    ))}
                  </div>
                ) : choices.length > 0 ? (
                  <select
                    id={path}
                    name={path}
                    disabled={disabled}
                    aria-required={state?.required}
                    className="w-full rounded-md border bg-transparent px-3 py-2"
                    value={
                      typeof field.state.value === "string"
                        ? field.state.value
                        : ""
                    }
                    onBlur={field.handleBlur}
                    onChange={(event) => {
                      setServerErrors([])
                      field.handleChange(
                        event.target.value === ""
                          ? property.type.context?.isOptional
                            ? undefined
                            : encoded._tag === "Union" &&
                                encoded.types.some(
                                  (member) =>
                                    member._tag === "Literal" &&
                                    member.literal === null,
                                )
                              ? null
                              : ""
                          : event.target.value,
                      )
                    }}
                    aria-invalid={errors.length > 0}
                    aria-describedby={`${path}-errors`}
                  >
                    <option value="">Select an option</option>
                    {choices.map((choice) => (
                      <option key={choice} value={choice}>
                        {choice}
                      </option>
                    ))}
                  </select>
                ) : textArea ? (
                  <textarea
                    id={path}
                    name={path}
                    disabled={disabled}
                    aria-required={state?.required}
                    className="min-h-24 w-full rounded-md border border-slate-300 bg-transparent px-3 py-2 dark:border-slate-600"
                    value={
                      typeof field.state.value === "string"
                        ? field.state.value
                        : ""
                    }
                    onBlur={field.handleBlur}
                    onChange={(event) => {
                      setServerErrors([])
                      field.handleChange(event.target.value)
                    }}
                    aria-invalid={errors.length > 0}
                    aria-describedby={`${path}-description ${path}-errors`}
                  />
                ) : boolean ? (
                  <div className="flex items-start gap-2">
                    <input
                      id={path}
                      name={path}
                      type="checkbox"
                      className={
                        "peer mt-0.5 size-4 shrink-0 " +
                        "disabled:grid disabled:appearance-none disabled:place-content-center disabled:rounded-[4px] disabled:border disabled:border-muted-foreground disabled:bg-muted disabled:text-muted-foreground disabled:cursor-not-allowed " +
                        "disabled:checked:before:h-2 disabled:checked:before:w-1 disabled:checked:before:-translate-y-px disabled:checked:before:rotate-45 disabled:checked:before:border-r-2 disabled:checked:before:border-b-2 disabled:checked:before:border-current " +
                        "forced-colors:disabled:appearance-auto forced-colors:disabled:checked:before:hidden"
                      }
                      disabled={readOnly || disabled}
                      aria-required={state?.required}
                      checked={field.state.value === true}
                      onBlur={field.handleBlur}
                      onChange={(event) => {
                        setServerErrors([])
                        field.handleChange(event.target.checked)
                      }}
                      aria-invalid={errors.length > 0}
                      aria-describedby={`${path}-description ${path}-errors`}
                    />
                    <label
                      htmlFor={path}
                      className="min-w-0 text-sm font-medium peer-disabled:text-muted-foreground"
                    >
                      {label}
                    </label>
                  </div>
                ) : (
                  <input
                    id={path}
                    name={path}
                    type={email ? "email" : "text"}
                    disabled={disabled}
                    aria-required={state?.required}
                    inputMode={numeric ? "decimal" : "text"}
                    className="w-full rounded-md border border-slate-300 bg-transparent px-3 py-2 dark:border-slate-600"
                    value={
                      typeof field.state.value === "string" ||
                      typeof field.state.value === "number"
                        ? field.state.value
                        : ""
                    }
                    onBlur={field.handleBlur}
                    onChange={(event) => {
                      setServerErrors([])
                      field.handleChange(event.target.value)
                    }}
                    aria-invalid={errors.length > 0}
                    aria-describedby={`${path}-description ${path}-errors`}
                  />
                )}
                {!calendar && (
                  <p
                    id={`${path}-description`}
                    className="text-sm text-slate-500"
                  >
                    {typeof description === "string" ? description : null}
                  </p>
                )}
                <div
                  id={`${path}-errors`}
                  role="alert"
                  className="text-sm text-rose-600"
                >
                  {errors.join(" ")}
                </div>
              </div>
            )
          }}
        </form.Field>
      )
    })
  }

  return (
    <form.AppForm>
      <form
        ref={formRef}
        // Shared with deferred calendar focus after its slots load.
        data-autofocus={autoFocus ? undefined : "false"}
        className="space-y-6"
        onSubmit={(event) => {
          event.preventDefault()
          event.stopPropagation()
          void form.handleSubmit()
        }}
      >
        {requestData?.prefill && (
          <form.Subscribe
            selector={(state) =>
              state.values[requestData.prefill?.dependency ?? ""]
            }
          >
            {(value) =>
              requestData.prefill && (
                <FormPrefill
                  form={form}
                  config={requestData.prefill}
                  value={value}
                  onReady={onReady}
                />
              )
            }
          </form.Subscribe>
        )}
        <form.Subscribe
          selector={(state) =>
            [
              state.values,
              state.submissionAttempts,
              state.isSubmitting,
            ] as const
          }
        >
          {([values, , isSubmitting]) => (
            <fieldset disabled={isSubmitting} className="space-y-6">
              {renderFields(schema.ast, values)}
            </fieldset>
          )}
        </form.Subscribe>
        {serverErrors
          .filter((error) => !error.field)
          .map((error) => (
            <p
              key={error.message}
              role="alert"
              className="text-sm text-rose-600"
            >
              {error.message}
            </p>
          ))}
        <form.Subscribe selector={(state) => state}>
          {(state) =>
            children(
              {
                formState: {
                  isSubmittingRequest: state.isSubmitting,
                  isSubmitting:
                    state.isSubmitting ||
                    Boolean(
                      requestData?.prefill &&
                        (!prefillReady ||
                          prefillReady !==
                            state.values[requestData.prefill.dependency]),
                    ),
                  isPristine: state.isPristine,
                  values: state.values,
                },
                clearLocalStorage,
              },
              validator,
            )
          }
        </form.Subscribe>
      </form>
    </form.AppForm>
  )
}

/** Stable row identities keep lookup state with its student when earlier rows are removed. */
function ExecutableList({
  label,
  addButtonLabel,
  count,
  disabled,
  onAdd,
  onRemove,
  renderItem,
}: {
  label: string
  addButtonLabel: string | undefined
  count: number
  disabled: boolean
  onAdd: () => void
  onRemove: (index: number) => void
  renderItem: (index: number) => ReactNode
}) {
  const [keys, setKeys] = useState(() =>
    Array.from({ length: count }, (_, index) => index),
  )
  const nextKey = useRef(count)
  return (
    <fieldset disabled={disabled} className="space-y-4">
      <legend className="font-semibold">{label}</legend>
      {Array.from({ length: count }, (_, index) => (
        <div key={keys[index]} className="space-y-4 rounded-md border p-4">
          {renderItem(index)}
          <button
            type="button"
            onClick={() => {
              setKeys((keys) => keys.filter((_, row) => row !== index))
              onRemove(index)
            }}
          >
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => {
          const key = nextKey.current++
          setKeys((keys) => [...keys, key])
          onAdd()
        }}
      >
        {addButtonLabel ?? `Add ${label.toLowerCase()}`}
      </button>
    </fieldset>
  )
}

function ExecutableCalendar({
  formRef,
  stepPath,
  path,
  options,
  metadata,
  label,
  description,
  disabled,
}: {
  formRef: RefObject<HTMLFormElement | null>
  stepPath: string
  path: string
  options: LookupOptions | undefined
  metadata: {
    readonly timeZone: string
    readonly locale: string
    readonly emptyMessageHtml?: string | undefined
    readonly loadErrorMessageHtml?: string | undefined
    readonly calendar?: CalendarSlotCalendarMetadata | undefined
  }
  label: string
  description: string | undefined
  disabled: boolean
}) {
  const service = useLookup()
  const [slots, setSlots] = useState<CalendarSlotFieldItem[]>([])
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading")
  const [attempt, retry] = useState(0)
  useEffect(() => {
    if (status !== "ready" || !formRef.current) return
    return focusFirstEditableControl(formRef.current)
  }, [status, formRef])
  useEffect(() => {
    let active = true
    void attempt // A retry intentionally repeats the token-scoped request.
    if (disabled) return
    setStatus("loading")
    service
      .fetchCalendarSlots(stepPath, path, options)
      .then((items) => {
        if (active) {
          setSlots(items)
          setStatus("ready")
        }
      })
      .catch(() => {
        if (active) setStatus("error")
      })
    return () => {
      active = false
    }
  }, [service, stepPath, path, options, attempt, disabled])
  return (
    <CalendarSlotField
      {...metadata}
      label={label}
      descriptionHtml={description}
      slots={slots}
      loading={status === "loading"}
      error={status === "error"}
      readOnly={disabled}
      onRetry={() => retry((value) => value + 1)}
    />
  )
}
