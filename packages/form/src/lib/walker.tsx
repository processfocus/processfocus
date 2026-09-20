import React, {
  Suspense,
  use,
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react"
import type {
  CalendarSlotField as CalendarSlotFieldType,
  FormComponent,
  ListField as ListFieldType,
  LookupField as LookupFieldType,
  MetricBreakdown as MetricBreakdownType,
  PluginField,
  ProviderUserField as ProviderUserFieldType,
  TableField as TableFieldType,
} from "@pf/form-client-representation/types"
import { FormComponentType } from "@pf/form-client-representation/types"
import {
  BooleanField,
  Button,
  CalendarSlotField,
  type CalendarSlotFieldItem,
  DateField,
  Field,
  FieldDescription,
  FieldLabel,
  FieldSetField,
  FileField,
  LookupField,
  type LookupFieldItem,
  RadioField,
  SelectField,
  TextAreaField,
  TextField,
  useFieldContext,
  useFormContext,
} from "@pf/shadcn-components"
import {
  type LookupOptions,
  type LookupService,
  useLookup,
} from "./lookup-context"
import { getPluginRenderer } from "./plugin-registry"

// Type alias for forms
type AnyAppForm = {
  AppField: React.ComponentType<{
    name: string
    children: () => React.JSX.Element
  }>
}

const effectiveReadOnly = (component: FormComponent): boolean | undefined => {
  if (component.disabled === true) return true
  return component.readonly
}

/**
 * Main walker function that processes client representation and emits React components
 *
 * @param form - The Tanstack form instance
 * @param components - The client representation (output of asClientRepresentation)
 * @param isFirstField - Whether this is the first field (for autofocus)
 * @param stepPath - The step path for file upload authorization (required when form has file fields)
 */
export const walkClientRepresentation = (
  form: AnyAppForm,
  components: Record<string, FormComponent>,
  isFirstField = true,
  stepPath?: string,
  enableProviderUserLookup = true,
  lookupOptions?: LookupOptions,
): React.JSX.Element[] => {
  const fields: React.JSX.Element[] = []
  let autoFocusAssigned = false

  for (const [fieldName, component] of Object.entries(components)) {
    if (component.hidden === true) {
      continue
    }

    const shouldAutoFocus =
      isFirstField &&
      !autoFocusAssigned &&
      !component.readonly &&
      !component.disabled
    if (shouldAutoFocus) {
      autoFocusAssigned = true
    }
    const field = processComponent(
      form,
      fieldName,
      component,
      shouldAutoFocus,
      stepPath,
      enableProviderUserLookup,
      lookupOptions,
    )
    fields.push(field)
  }

  return fields
}

/**
 * Process a single component from the client representation
 */
const processComponent = (
  form: AnyAppForm,
  fieldName: string,
  component: FormComponent,
  shouldAutoFocus: boolean,
  stepPath?: string,
  enableProviderUserLookup = true,
  lookupOptions?: LookupOptions,
): React.JSX.Element => {
  const readOnly = effectiveReadOnly(component)
  // descriptionHtml opts into trusted HTML rendering. Form descriptions are
  // admin-authored process-definition content, not end-user supplied input.
  switch (component._tag) {
    case FormComponentType.Text:
      return (
        <form.AppField key={component.field} name={component.field}>
          {() => (
            <TextField
              label={component.label}
              descriptionHtml={component.description}
              autoFocus={shouldAutoFocus}
              autoComplete={component.autoComplete}
              {...(readOnly !== undefined && {
                readOnly,
              })}
            />
          )}
        </form.AppField>
      )

    case FormComponentType.TextArea:
      return (
        <form.AppField key={component.field} name={component.field}>
          {() => (
            <TextAreaField
              label={component.label}
              descriptionHtml={component.description}
              autoFocus={shouldAutoFocus}
              {...(readOnly !== undefined && {
                readOnly,
              })}
            />
          )}
        </form.AppField>
      )

    case FormComponentType.Number:
      return (
        <form.AppField key={component.field} name={component.field}>
          {() => (
            <TextField
              inputMode="decimal"
              label={component.label}
              descriptionHtml={component.description}
              autoFocus={shouldAutoFocus}
              autoComplete={component.autoComplete}
              {...(readOnly !== undefined && {
                readOnly,
              })}
            />
          )}
        </form.AppField>
      )

    case FormComponentType.Date:
      return (
        <form.AppField key={component.field} name={component.field}>
          {() => (
            <DateField
              label={component.label}
              descriptionHtml={component.description}
              autoFocus={shouldAutoFocus}
              {...(readOnly !== undefined && {
                readOnly,
              })}
            />
          )}
        </form.AppField>
      )

    case FormComponentType.Email:
      return (
        <form.AppField key={component.field} name={component.field}>
          {() => (
            <TextField
              type="email"
              inputMode="email"
              label={component.label}
              descriptionHtml={component.description}
              autoFocus={shouldAutoFocus}
              autoComplete={component.autoComplete}
              {...(readOnly !== undefined && {
                readOnly,
              })}
            />
          )}
        </form.AppField>
      )

    case FormComponentType.Phone:
      return (
        <form.AppField key={component.field} name={component.field}>
          {() => (
            <TextField
              type="tel"
              inputMode="tel"
              label={component.label}
              descriptionHtml={component.description}
              autoFocus={shouldAutoFocus}
              autoComplete={component.autoComplete}
              {...(readOnly !== undefined && {
                readOnly,
              })}
            />
          )}
        </form.AppField>
      )

    case FormComponentType.ProviderUser:
      if (!enableProviderUserLookup) {
        return (
          <form.AppField key={component.field} name={component.field}>
            {() => (
              <TextField
                label={component.label}
                descriptionHtml={component.description}
                autoFocus={shouldAutoFocus}
                autoComplete={component.autoComplete}
                {...(readOnly !== undefined && {
                  readOnly,
                })}
              />
            )}
          </form.AppField>
        )
      }

      if (!stepPath) {
        throw new Error(
          `ProviderUserField "${component.field}" requires stepPath for fetching suggestions. ` +
            `Please provide stepPath when calling walkClientRepresentation.`,
        )
      }
      return (
        <form.AppField key={component.field} name={component.field}>
          {() => (
            <IndependentLookupFieldWrapper
              component={component}
              stepPath={stepPath}
              lookupOptions={lookupOptions}
              shouldAutoFocus={shouldAutoFocus}
            />
          )}
        </form.AppField>
      )

    case FormComponentType.Boolean:
      return (
        <form.AppField key={component.field} name={component.field}>
          {() => (
            <BooleanField
              label={component.label}
              descriptionHtml={component.description}
              {...(readOnly !== undefined && {
                readOnly,
              })}
            />
          )}
        </form.AppField>
      )

    case FormComponentType.Select:
      return (
        <form.AppField key={component.field} name={component.field}>
          {() => (
            <SelectField
              label={component.label}
              descriptionHtml={component.description}
              options={component.options}
              {...(component.emptyValue !== undefined && {
                emptyValue: component.emptyValue,
              })}
              autoFocus={shouldAutoFocus}
              {...(readOnly !== undefined && {
                readOnly,
              })}
            />
          )}
        </form.AppField>
      )

    case FormComponentType.Radio:
      return (
        <form.AppField key={component.field} name={component.field}>
          {() => (
            <RadioField
              label={component.label}
              descriptionHtml={component.description}
              options={component.options}
              autoFocus={shouldAutoFocus}
              {...(readOnly !== undefined && {
                readOnly,
              })}
            />
          )}
        </form.AppField>
      )

    case FormComponentType.Lookup:
      if (!stepPath) {
        throw new Error(
          `LookupField "${component.field}" requires stepPath for fetching suggestions. ` +
            `Please provide stepPath when calling walkClientRepresentation.`,
        )
      }
      return (
        <form.AppField key={component.field} name={component.field}>
          {() => (
            <LookupFieldWrapper
              component={component}
              stepPath={stepPath}
              lookupOptions={lookupOptions}
              shouldAutoFocus={shouldAutoFocus}
            />
          )}
        </form.AppField>
      )

    case FormComponentType.CalendarSlot:
      if (!stepPath) {
        throw new Error(
          `CalendarSlotField "${component.field}" requires stepPath for fetching slots. ` +
            `Please provide stepPath when calling walkClientRepresentation.`,
        )
      }
      return (
        <form.AppField key={component.field} name={component.field}>
          {() => (
            <CalendarSlotFieldWrapper
              component={component}
              stepPath={stepPath}
              lookupOptions={lookupOptions}
              shouldAutoFocus={shouldAutoFocus}
            />
          )}
        </form.AppField>
      )

    case FormComponentType.File:
      if (!stepPath) {
        throw new Error(
          `FileField "${component.field}" requires stepPath for authorization. ` +
            `Please provide stepPath when calling walkClientRepresentation.`,
        )
      }
      return (
        <form.AppField key={component.field} name={component.field}>
          {() => (
            <FileField
              label={component.label}
              descriptionHtml={component.description}
              documentStore={component.documentStore}
              stepPath={stepPath}
              {...(component.accept != null && { accept: component.accept })}
              {...(component.maxSize != null && { maxSize: component.maxSize })}
              {...(readOnly !== undefined && {
                readOnly,
              })}
            />
          )}
        </form.AppField>
      )

    case FormComponentType.FieldSet: {
      const children = walkClientRepresentation(
        form,
        component.children,
        false,
        stepPath,
        enableProviderUserLookup,
        lookupOptions,
      )
      return (
        <FieldSetField key={fieldName} label={component.label}>
          {children}
        </FieldSetField>
      )
    }

    case FormComponentType.List: {
      return (
        <form.AppField key={component.field} name={component.field}>
          {() => (
            <ListFieldRenderer
              form={form}
              component={component}
              stepPath={stepPath}
              enableProviderUserLookup={enableProviderUserLookup}
              lookupOptions={lookupOptions}
            />
          )}
        </form.AppField>
      )
    }

    case FormComponentType.Table: {
      return (
        <form.AppField key={component.field} name={component.field}>
          {() => <TableFieldRenderer component={component} />}
        </form.AppField>
      )
    }

    case FormComponentType.Plugin: {
      return (
        <PluginFieldRenderer
          key={fieldName}
          form={form}
          component={component}
          shouldAutoFocus={shouldAutoFocus}
          {...(stepPath !== undefined && { stepPath })}
          {...(lookupOptions?.todoId !== undefined && {
            todoId: lookupOptions.todoId,
          })}
        />
      )
    }

    case FormComponentType.Static: {
      return (
        <div key={fieldName} data-slot="static-field" className="space-y-2">
          {component.label && (
            <div
              data-slot="static-field-label"
              className="text-sm font-medium leading-none"
            >
              {component.label}
            </div>
          )}
          <div
            data-slot="static-field-content"
            className="text-sm text-muted-foreground"
          >
            {component.content || component.description}
          </div>
        </div>
      )
    }

    case FormComponentType.Link: {
      if (component.display === "button") {
        return (
          <div key={fieldName} data-slot="static-link" className="space-y-2">
            <Button
              asChild
              className={
                component.color === "blue"
                  ? "bg-blue-600 text-white hover:bg-blue-700"
                  : undefined
              }
            >
              <a
                data-slot="static-link-button"
                href={component.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                {component.text}
              </a>
            </Button>
          </div>
        )
      }

      return (
        <div key={fieldName} data-slot="static-link" className="space-y-2">
          {component.label && (
            <div
              data-slot="static-link-label"
              className="text-sm font-medium leading-none"
            >
              {component.label}
            </div>
          )}
          <a
            data-slot="static-link-anchor"
            href={component.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-primary underline-offset-4 hover:underline"
          >
            {component.text}
          </a>
        </div>
      )
    }

    case FormComponentType.MetricBreakdown: {
      return (
        <MetricBreakdownPluginRenderer
          key={fieldName}
          form={form}
          component={component}
          shouldAutoFocus={shouldAutoFocus}
        />
      )
    }

    default: {
      const _exhaustive: never = component
      throw new Error(
        `Unhandled component type: ${(_exhaustive as FormComponent)._tag}`,
      )
    }
  }
}

function TableFieldRenderer({ component }: { component: TableFieldType }) {
  const field = useFieldContext<unknown[]>()
  const rows = Array.isArray(field.state.value) ? field.state.value : []
  const columns = Object.entries(component.itemChildren).flatMap(
    ([key, child]) =>
      "field" in child ? [{ key, label: child.label || key }] : [],
  )

  return (
    <Field>
      <FieldLabel>{component.label}</FieldLabel>
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full min-w-max text-left text-sm">
          <thead className="border-b bg-muted/50 text-muted-foreground">
            <tr>
              {columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className="px-3 py-2 font-medium"
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td
                  className="px-3 py-3 text-muted-foreground"
                  colSpan={Math.max(columns.length, 1)}
                >
                  No rows.
                </td>
              </tr>
            ) : (
              rows.map((row, index) => (
                <tr
                  key={getTableRowKey(row, component.field, index)}
                  className="border-b last:border-0"
                >
                  {columns.map((column) => (
                    <td key={column.key} className="px-3 py-2 align-top">
                      {formatTableCellValue(getTableCellValue(row, column.key))}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {component.description && (
        <FieldDescription trustedHtml={component.description} />
      )}
    </Field>
  )
}

const getTableCellValue = (row: unknown, key: string): unknown =>
  typeof row === "object" && row !== null && !Array.isArray(row)
    ? (row as Record<string, unknown>)[key]
    : undefined

const getTableRowKey = (row: unknown, field: string, index: number): string => {
  if (typeof row === "object" && row !== null) {
    const explicitKey = (row as Record<string, unknown>)["id"]
    if (typeof explicitKey === "string" || typeof explicitKey === "number") {
      return `${field}-id-${explicitKey}`
    }
  }

  return `${field}-row-${index}`
}

const formatTableCellValue = (value: unknown): string => {
  if (value === null || value === undefined || value === "") return "-"
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value)
  }
  // Keep unexpected table cell shapes visible instead of silently blanking them.
  return JSON.stringify(value)
}

function MetricBreakdownPluginRenderer({
  form,
  component,
  shouldAutoFocus,
}: {
  readonly form: AnyAppForm
  readonly component: MetricBreakdownType
  readonly shouldAutoFocus: boolean
}) {
  if (!component.rendererPluginType) {
    return (
      <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
        No renderer plugin configured for metric breakdown "{component.title}".
      </div>
    )
  }

  const renderer = getPluginRenderer(component.rendererPluginType)
  if (!renderer) {
    return (
      <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800">
        No renderer registered for plugin type: {component.rendererPluginType}
      </div>
    )
  }

  const pluginComponent: PluginField = {
    _tag: FormComponentType.Plugin,
    field: component.field,
    label: component.label,
    pluginType: component.rendererPluginType,
    pluginData: component,
    readonly: true,
  }

  return renderer(form, pluginComponent, shouldAutoFocus)
}

/**
 * Wrapper component that fetches lookup suggestions and renders the LookupField UI.
 * Uses the LookupProvider context to make GraphQL calls with debounced search.
 *
 * For dependent lookups (component.dependencies is set), subscribes to dependency
 * field values and calls the typed query. Re-queries and clears invalid selections
 * when dependencies change.
 */
function LookupFieldWrapper({
  component,
  stepPath,
  lookupOptions,
  shouldAutoFocus,
}: {
  component: LookupFieldType
  stepPath: string
  lookupOptions: LookupOptions | undefined
  shouldAutoFocus: boolean
}) {
  const hasDeps =
    component.dependencies &&
    component.dependencies.length > 0 &&
    component.queryName

  return hasDeps ? (
    <DependentLookupFieldWrapper
      component={component}
      shouldAutoFocus={shouldAutoFocus}
    />
  ) : (
    <IndependentLookupFieldWrapper
      component={component}
      stepPath={stepPath}
      lookupOptions={lookupOptions}
      shouldAutoFocus={shouldAutoFocus}
    />
  )
}

/**
 * Independent lookup — uses the generic lookupSuggestions query.
 */
function IndependentLookupFieldWrapper({
  component,
  stepPath,
  lookupOptions,
  shouldAutoFocus,
}: {
  component: LookupFieldType | ProviderUserFieldType
  stepPath: string
  lookupOptions: LookupOptions | undefined
  shouldAutoFocus: boolean
}) {
  const lookupService = useLookup()
  const readOnly = effectiveReadOnly(component)
  const [items, setItems] = useState<LookupFieldItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Fetch initial items on mount
  useEffect(() => {
    const fieldName = component.field.includes(".")
      ? (component.field.split(".").pop() ?? component.field)
      : component.field
    lookupService
      .fetchSuggestions(stepPath, fieldName, "", 20, lookupOptions)
      .then((results) => {
        setItems(results)
        setError(undefined)
      })
      .catch((err) => {
        setItems([])
        setError(
          err instanceof Error ? err.message : "Failed to load suggestions",
        )
      })
  }, [stepPath, component.field, lookupService, lookupOptions])

  const handleSearch = useCallback(
    (filter: string) => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
      }
      debounceRef.current = setTimeout(() => {
        setLoading(true)
        setError(undefined)
        const fieldName = component.field.includes(".")
          ? (component.field.split(".").pop() ?? component.field)
          : component.field
        lookupService
          .fetchSuggestions(stepPath, fieldName, filter, 20, lookupOptions)
          .then((results) => {
            setItems(results)
            setLoading(false)
          })
          .catch((err) => {
            setItems([])
            setLoading(false)
            setError(
              err instanceof Error ? err.message : "Failed to load suggestions",
            )
          })
      }, 300)
    },
    [stepPath, component.field, lookupService, lookupOptions],
  )

  return (
    <LookupField
      label={component.label}
      descriptionHtml={component.description}
      items={items}
      onSearch={handleSearch}
      loading={loading}
      error={error}
      {...(readOnly !== undefined && {
        readOnly,
      })}
      autoFocus={shouldAutoFocus}
      allowFreeText={getLookupAllowFreeText(component)}
    />
  )
}

const getLookupAllowFreeText = (
  component: LookupFieldType | ProviderUserFieldType,
): boolean | undefined =>
  component._tag === FormComponentType.Lookup
    ? component.allowFreeText
    : undefined

const calendarSlotResourceCache = new WeakMap<
  LookupService,
  Map<string, Promise<CalendarSlotFieldItem[]>>
>()

// Resource lifetime is tied to the lookup service. Public todo pages create a
// per-token service, so time-sensitive slot data is discarded on navigation.

const calendarSlotResourceKey = (
  stepPath: string,
  fieldName: string,
  lookupOptions: LookupOptions | undefined,
) => `${stepPath}\u0000${fieldName}\u0000${lookupOptions?.todoId ?? ""}`

const getCalendarSlotResource = (
  lookupService: LookupService,
  stepPath: string,
  fieldName: string,
  lookupOptions: LookupOptions | undefined,
) => {
  let serviceCache = calendarSlotResourceCache.get(lookupService)
  if (!serviceCache) {
    serviceCache = new Map<string, Promise<CalendarSlotFieldItem[]>>()
    calendarSlotResourceCache.set(lookupService, serviceCache)
  }

  const key = calendarSlotResourceKey(stepPath, fieldName, lookupOptions)
  const cached = serviceCache.get(key)
  if (cached) {
    return cached
  }

  const promise = lookupService.fetchCalendarSlots(
    stepPath,
    fieldName,
    lookupOptions,
  )
  serviceCache.set(key, promise)
  return promise
}

const clearCalendarSlotResource = (
  lookupService: LookupService,
  stepPath: string,
  fieldName: string,
  lookupOptions: LookupOptions | undefined,
) => {
  calendarSlotResourceCache
    .get(lookupService)
    ?.delete(calendarSlotResourceKey(stepPath, fieldName, lookupOptions))
}

interface CalendarSlotLoadErrorBoundaryProps {
  readonly children: React.ReactNode
  readonly onReset: () => void
  readonly renderError: (error: unknown, reset: () => void) => React.ReactNode
  readonly resetKey: string
}

interface CalendarSlotLoadErrorBoundaryState {
  readonly error: unknown | null
  readonly resetKey: string
}

class CalendarSlotLoadErrorBoundary extends React.Component<
  CalendarSlotLoadErrorBoundaryProps,
  CalendarSlotLoadErrorBoundaryState
> {
  override state: CalendarSlotLoadErrorBoundaryState = {
    error: null,
    resetKey: this.props.resetKey,
  }

  static getDerivedStateFromError(
    error: unknown,
  ): Partial<CalendarSlotLoadErrorBoundaryState> {
    return { error }
  }

  static getDerivedStateFromProps(
    props: CalendarSlotLoadErrorBoundaryProps,
    state: CalendarSlotLoadErrorBoundaryState,
  ): Partial<CalendarSlotLoadErrorBoundaryState> | null {
    if (props.resetKey !== state.resetKey) {
      return { error: null, resetKey: props.resetKey }
    }

    return null
  }

  private readonly reset = () => {
    this.props.onReset()
    this.setState({ error: null })
  }

  override render() {
    if (this.state.error) {
      return this.props.renderError(this.state.error, this.reset)
    }

    return this.props.children
  }
}

function CalendarSlotFieldView({
  component,
  error,
  loading,
  onRetry,
  shouldAutoFocus,
  slots,
}: {
  readonly component: CalendarSlotFieldType
  readonly error?: boolean | undefined
  readonly loading: boolean
  readonly onRetry?: (() => void) | undefined
  readonly shouldAutoFocus: boolean
  readonly slots: CalendarSlotFieldItem[]
}) {
  const readOnly = effectiveReadOnly(component)

  return (
    <CalendarSlotField
      label={component.label}
      descriptionHtml={component.description}
      emptyMessageHtml={component.emptyMessageHtml}
      loadErrorMessageHtml={component.loadErrorMessageHtml}
      slots={slots}
      loading={loading}
      error={error}
      autoFocus={shouldAutoFocus}
      timeZone={component.timeZone}
      locale={component.locale}
      onRetry={onRetry}
      {...(readOnly !== undefined && {
        readOnly,
      })}
      {...(component.calendar !== undefined && {
        calendar: component.calendar,
      })}
    />
  )
}

function CalendarSlotFieldContent({
  component,
  fieldName,
  lookupOptions,
  lookupService,
  shouldAutoFocus,
  stepPath,
}: {
  readonly component: CalendarSlotFieldType
  readonly fieldName: string
  readonly lookupOptions: LookupOptions | undefined
  readonly lookupService: LookupService
  readonly shouldAutoFocus: boolean
  readonly stepPath: string
}) {
  const slots = use(
    getCalendarSlotResource(lookupService, stepPath, fieldName, lookupOptions),
  )

  return (
    <CalendarSlotFieldView
      component={component}
      loading={false}
      shouldAutoFocus={shouldAutoFocus}
      slots={slots}
    />
  )
}

function CalendarSlotFieldWrapper({
  component,
  stepPath,
  lookupOptions,
  shouldAutoFocus,
}: {
  readonly component: CalendarSlotFieldType
  readonly stepPath: string
  readonly lookupOptions: LookupOptions | undefined
  readonly shouldAutoFocus: boolean
}) {
  const lookupService = useLookup()
  const [clientReady, setClientReady] = useState(false)
  const fieldName = component.field
  const resetKey = calendarSlotResourceKey(stepPath, fieldName, lookupOptions)

  useEffect(() => {
    setClientReady(true)
  }, [])

  const fallback = (
    <CalendarSlotFieldView
      component={component}
      loading
      shouldAutoFocus={shouldAutoFocus}
      slots={[]}
    />
  )

  if (!clientReady) {
    return fallback
  }

  return (
    <CalendarSlotLoadErrorBoundary
      resetKey={resetKey}
      onReset={() =>
        clearCalendarSlotResource(
          lookupService,
          stepPath,
          fieldName,
          lookupOptions,
        )
      }
      renderError={(_error, reset) => (
        <CalendarSlotFieldView
          component={component}
          error
          loading={false}
          onRetry={reset}
          shouldAutoFocus={shouldAutoFocus}
          slots={[]}
        />
      )}
    >
      <Suspense fallback={fallback}>
        <CalendarSlotFieldContent
          key={resetKey}
          component={component}
          fieldName={fieldName}
          lookupOptions={lookupOptions}
          lookupService={lookupService}
          shouldAutoFocus={shouldAutoFocus}
          stepPath={stepPath}
        />
      </Suspense>
    </CalendarSlotLoadErrorBoundary>
  )
}

/**
 * Read current dependency values from the form store.
 */
function readDepValues(
  // biome-ignore lint/suspicious/noExplicitAny: form API generic variance
  formCtx: any,
  dependencies: ReadonlyArray<string>,
): Record<string, string> {
  const values = formCtx.state.values as Record<string, unknown>
  const result: Record<string, string> = {}
  for (const dep of dependencies) {
    result[dep] = (values[dep] as string) ?? ""
  }
  return result
}

/**
 * Dependent lookup — subscribes to dependency field values via form store,
 * calls the typed per-lookup query, and clears the field when deps change.
 */
function DependentLookupFieldWrapper({
  component,
  shouldAutoFocus,
}: {
  component: LookupFieldType
  shouldAutoFocus: boolean
}) {
  const lookupService = useLookup()
  const readOnly = effectiveReadOnly(component)
  const formCtx = useFormContext()
  const field = useFieldContext<string>()

  const dependencies = component.dependencies ?? []
  const queryName = component.queryName ?? ""

  const [items, setItems] = useState<LookupFieldItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Reactive dependency values — updated via form store subscription
  const [depValues, setDepValues] = useState<Record<string, string>>(() =>
    readDepValues(formCtx, dependencies),
  )

  // Subscribe to form store changes to track dependency values
  useEffect(() => {
    const unsub = formCtx.store.subscribe(() => {
      setDepValues((prev) => {
        const next = readDepValues(formCtx, dependencies)
        const changed = dependencies.some((d) => prev[d] !== next[d])
        return changed ? next : prev
      })
    })
    return () => unsub.unsubscribe()
  }, [formCtx, formCtx.store, dependencies])

  const allDepsFilled = dependencies.every((d) => Boolean(depValues[d]))

  // Stable key for dependency values — triggers re-fetch on change
  const depKey = dependencies.map((d) => depValues[d] ?? "").join("\0")
  const prevDepKeyRef = useRef<string | null>(null)
  const lastFilterRef = useRef("")
  const clearFieldValue = useEffectEvent(() => {
    if (field.state.value) {
      field.setValue("")
    }
  })
  const getCurrentDepValues = useEffectEvent(() =>
    readDepValues(formCtx, dependencies),
  )

  // When dependencies change: re-fetch and clear invalid selection
  useEffect(() => {
    const isInitialMount = prevDepKeyRef.current === null
    prevDepKeyRef.current = depKey

    if (!allDepsFilled) {
      setItems([])
      return
    }

    // Clear field value on dep change (not initial mount)
    if (!isInitialMount) {
      clearFieldValue()
    }

    // Fetch with current filter
    const filter = lastFilterRef.current
    setLoading(true)
    setError(undefined)

    const currentDepValues = getCurrentDepValues()
    const variables: Record<string, unknown> = {
      input: { filter, ...currentDepValues },
      limit: 20,
    }

    lookupService
      .fetchDependentSuggestions(queryName, variables)
      .then((results) => {
        setItems(results)
        setLoading(false)
        setError(undefined)
      })
      .catch((err) => {
        console.error("Lookup fetch failed:", err)
        setItems([])
        setLoading(false)
        setError(
          err instanceof Error ? err.message : "Failed to load suggestions",
        )
      })
  }, [depKey, allDepsFilled, queryName, lookupService])

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  const handleSearch = (filter: string) => {
    lastFilterRef.current = filter
    if (!allDepsFilled) return

    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
    }
    debounceRef.current = setTimeout(() => {
      setLoading(true)
      setError(undefined)

      const currentDepValues = readDepValues(formCtx, dependencies)
      const variables: Record<string, unknown> = {
        input: { filter, ...currentDepValues },
        limit: 20,
      }

      lookupService
        .fetchDependentSuggestions(queryName, variables)
        .then((results) => {
          setItems(results)
          setLoading(false)
        })
        .catch((err) => {
          console.error("Lookup fetch failed:", err)
          setItems([])
          setLoading(false)
          setError(
            err instanceof Error ? err.message : "Failed to load suggestions",
          )
        })
    }, 300)
  }

  return (
    <LookupField
      label={component.label}
      descriptionHtml={component.description}
      items={items}
      onSearch={handleSearch}
      loading={loading}
      error={error}
      readOnly={readOnly === true || !allDepsFilled}
      autoFocus={shouldAutoFocus}
    />
  )
}

/**
 * Create path-indexed copies of itemChildren for a specific array index.
 * E.g., if field is "students" and itemChildren has "first_name" at path "students",
 * this produces "first_name" at path "students[0].first_name" for index 0.
 *
 * If parentReadOnly is true, all child fields will be marked as readonly.
 */
function indexItemChildren(
  itemChildren: Record<string, FormComponent>,
  field: string,
  index: number,
  parentReadOnly?: boolean,
): Record<string, FormComponent> {
  const result: Record<string, FormComponent> = {}
  for (const [key, child] of Object.entries(itemChildren)) {
    if ("field" in child) {
      // Replace the base field path with the indexed version
      const childFieldName = child.field.startsWith(`${field}.`)
        ? child.field.slice(field.length + 1)
        : child.field === field
          ? key
          : key
      result[key] = {
        ...child,
        field: `${field}[${index}].${childFieldName}`,
        // Propagate parent readonly if specified
        ...(parentReadOnly !== undefined && { readonly: parentReadOnly }),
      } as FormComponent
    } else {
      result[key] = child
    }
  }
  return result
}

/**
 * Component that renders a list/array field with add/remove functionality.
 *
 * Uses TanStack Form's array field API (pushFieldValue, removeFieldValue)
 * and recursively renders itemChildren for each array item.
 */
function ListFieldRenderer({
  form,
  component,
  stepPath,
  enableProviderUserLookup,
  lookupOptions,
}: {
  form: AnyAppForm
  component: ListFieldType
  stepPath?: string | undefined
  enableProviderUserLookup: boolean
  lookupOptions: LookupOptions | undefined
}) {
  const formCtx = useFormContext()
  const field = useFieldContext<unknown[]>()
  const readOnly = effectiveReadOnly(component)

  // Subscribe to the array field value to get the current item count
  const items = (field.state.value as unknown[]) ?? []

  const [itemKeyState, setItemKeyState] = useState(() => ({
    keys: Array.from({ length: items.length }, (_, index) => index),
    nextKey: items.length,
  }))
  const warnedProviderUserLookupDisabled = useRef(false)

  useEffect(() => {
    setItemKeyState((current) => {
      if (current.keys.length === items.length) return current
      if (current.keys.length > items.length) {
        return { ...current, keys: current.keys.slice(0, items.length) }
      }

      const addedCount = items.length - current.keys.length
      return {
        keys: [
          ...current.keys,
          ...Array.from(
            { length: addedCount },
            (_, index) => current.nextKey + index,
          ),
        ],
        nextKey: current.nextKey + addedCount,
      }
    })
  }, [items.length])

  useEffect(() => {
    if (enableProviderUserLookup) {
      warnIfListItemProviderUserLookupDisabled(
        component.itemChildren,
        warnedProviderUserLookupDisabled,
      )
    }
  }, [component.itemChildren, enableProviderUserLookup])

  // Build default item value from the itemChildren structure
  const buildEmptyItem = (): Record<string, unknown> => {
    const item: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(component.itemChildren)) {
      if ("field" in child) {
        switch (child._tag) {
          case FormComponentType.Text:
          case FormComponentType.Email:
          case FormComponentType.Phone:
          case FormComponentType.ProviderUser:
          case FormComponentType.File:
          case FormComponentType.CalendarSlot:
            item[key] = ""
            break
          case FormComponentType.Number:
            item[key] = 0
            break
          case FormComponentType.Boolean:
            item[key] = false
            break
          default:
            item[key] = ""
        }
      }
    }
    return item
  }

  const handleAdd = () => {
    setItemKeyState((current) => ({
      keys: [...current.keys, current.nextKey],
      nextKey: current.nextKey + 1,
    }))
    formCtx.pushFieldValue(component.field as never, buildEmptyItem() as never)
  }

  const handleRemove = (index: number) => {
    setItemKeyState((current) => ({
      ...current,
      keys: current.keys.filter((_, itemIndex) => itemIndex !== index),
    }))
    formCtx.removeFieldValue(component.field as never, index)
  }

  return (
    <FieldSetField label={component.label}>
      {items.map((_, index) => {
        const itemKey =
          itemKeyState.keys[index] ??
          itemKeyState.nextKey + index - itemKeyState.keys.length
        const indexedChildren = indexItemChildren(
          component.itemChildren,
          component.field,
          index,
          readOnly,
        )
        return (
          <div
            key={`${component.field}-item-${itemKey}`}
            className="flex flex-col gap-4 rounded-md border p-4"
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-muted-foreground">
                {component.label} #{index + 1}
              </span>
              {readOnly !== true && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => handleRemove(index)}
                >
                  Remove
                </Button>
              )}
            </div>
            {walkClientRepresentation(
              form,
              indexedChildren,
              false,
              stepPath,
              false,
              lookupOptions,
            )}
          </div>
        )
      })}
      {readOnly !== true && (
        <Button type="button" variant="outline" onClick={handleAdd}>
          {component.addButtonLabel ?? `Add ${component.label.toLowerCase()}`}
        </Button>
      )}
    </FieldSetField>
  )
}

const warnIfListItemProviderUserLookupDisabled = (
  children: Record<string, FormComponent>,
  warned: { current: boolean },
) => {
  const hasProviderUserField = Object.values(children).some(
    componentContainsProviderUser,
  )
  if (
    hasProviderUserField &&
    !warned.current &&
    process.env["NODE_ENV"] !== "production"
  ) {
    warned.current = true
    console.warn(
      "ProviderUserField lookup is disabled inside ListField until nested submit-time authorization is supported.",
    )
  }
}

const componentContainsProviderUser = (component: FormComponent): boolean => {
  switch (component._tag) {
    case FormComponentType.ProviderUser:
      return true
    case FormComponentType.FieldSet:
      return Object.values(component.children).some(
        componentContainsProviderUser,
      )
    case FormComponentType.List:
    case FormComponentType.Table:
      return Object.values(component.itemChildren).some(
        componentContainsProviderUser,
      )
    default:
      return false
  }
}

// Global map of in-flight script loads keyed by src URL.
// Ensures concurrent renders share a single load promise per script.
const scriptLoadPromises = new Map<string, Promise<void>>()

function loadScript(src: string, async: boolean): Promise<void> {
  const existing = scriptLoadPromises.get(src)
  if (existing) return existing

  const promise = new Promise<void>((resolve, reject) => {
    // Script may already be in the DOM from a previous page load
    if (document.querySelector(`script[src="${src}"]`)) {
      resolve()
      return
    }

    const el = document.createElement("script")
    el.src = src
    el.async = async
    el.onload = () => resolve()
    el.onerror = () => reject(new Error(`Failed to load script: ${src}`))
    document.head.appendChild(el)
  })

  scriptLoadPromises.set(src, promise)
  return promise
}

/**
 * Minimal error boundary for plugin renderers.
 * Catches render errors from lazy-loaded plugin components.
 */
class PluginErrorBoundary extends React.Component<
  { pluginType: string; children: React.ReactNode },
  { error: string | null }
> {
  constructor(props: { pluginType: string; children: React.ReactNode }) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error: Error): { error: string } {
    return { error: error.message }
  }

  override render() {
    if (this.state.error) {
      return (
        <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          Error rendering plugin "{this.props.pluginType}": {this.state.error}
        </div>
      )
    }
    return this.props.children
  }
}

/**
 * Component that loads external scripts before rendering a plugin field.
 *
 * Scripts are loaded lazily when the field is first encountered, preventing
 * unnecessary network requests for plugins not used in the current form.
 */
function PluginFieldRenderer({
  form,
  component,
  shouldAutoFocus,
  todoId,
  stepPath,
}: {
  form: AnyAppForm
  component: PluginField
  shouldAutoFocus: boolean
  todoId?: string
  stepPath?: string
}) {
  const [scriptsLoaded, setScriptsLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!component.scripts || component.scripts.length === 0) {
      setScriptsLoaded(true)
      return
    }

    Promise.all(
      component.scripts.map((s) => loadScript(s.src, s.async ?? true)),
    ).then(
      () => setScriptsLoaded(true),
      (err) =>
        setError(err instanceof Error ? err.message : "Failed to load scripts"),
    )
  }, [component.scripts])

  if (error) {
    return (
      <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800">
        Error loading plugin: {error}
      </div>
    )
  }

  if (!scriptsLoaded) {
    return <div>Loading plugin...</div>
  }

  const renderer = getPluginRenderer(component.pluginType)
  if (!renderer) {
    return (
      <div>No renderer registered for plugin type: {component.pluginType}</div>
    )
  }

  return (
    <PluginErrorBoundary pluginType={component.pluginType}>
      {renderer(
        form,
        component,
        shouldAutoFocus,
        todoId !== undefined || stepPath !== undefined
          ? {
              ...(todoId !== undefined && { todoId }),
              ...(stepPath !== undefined && { stepPath }),
            }
          : undefined,
      )}
    </PluginErrorBoundary>
  )
}
