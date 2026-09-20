"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { PublicTodoStateContent } from "./public-todo-state-content"
import { useActiveFrontendClientPlugins } from "@/components/frontend-client-plugin-provider"
import { reportClientException } from "@/lib/client-plugin-error-reporting"
import {
  type CalendarSlotItem,
  type FieldError,
  type FormActionsContext,
  LookupProvider,
  type LookupService,
  type LookupSuggestion,
  dynamicForm,
} from "@/lib/public-todo-form-runtime"
import {
  type PublicTodoCompletionResult,
  type PublicTodoFormMetadata,
  type PublicTodoStatus,
  publicTodoDefaultValues,
  publicTodoJsonSchema,
  publicTodoStateCopy,
  publicTodoTerminalStatusFromResult,
  publicTodoUnsupportedMetadataTypes,
} from "@/lib/public-todo-model"

interface PublicTodoClientProps {
  readonly token: string
  readonly todoId: string
  readonly submittedTitle: string
  readonly formMetadata: PublicTodoFormMetadata
}

interface SubmitResponse {
  readonly todo?: PublicTodoCompletionResult
  readonly errors?: FieldError[]
  readonly error?: string
}

interface FreshLinkResponse {
  readonly todo?: PublicTodoCompletionResult
  readonly error?: string
}

interface LookupResponse {
  readonly items?: LookupSuggestion[]
  readonly error?: string
}

interface CalendarSlotsResponse {
  readonly items?: CalendarSlotItem[]
  readonly error?: string
}

class PublicTodoClientRequestError extends Error {
  readonly responseStatus: number | null

  constructor(message: string, responseStatus: number | null) {
    super(message)
    this.name = "PublicTodoClientRequestError"
    this.responseStatus = responseStatus
  }
}

type ActiveFrontendClientPlugins = Parameters<typeof reportClientException>[0]

interface UnsupportedPublicTodoStateProps {
  readonly activePlugins: ActiveFrontendClientPlugins
  readonly processName: string
  readonly stepPath: string
  readonly todoId: string
  readonly unsupportedTypes: readonly string[]
}

const UnsupportedPublicTodoState = ({
  activePlugins,
  processName,
  stepPath,
  todoId,
  unsupportedTypes,
}: UnsupportedPublicTodoStateProps) => {
  const hasMalformedMetadata = unsupportedTypes.includes("unknown")
  const failureReason = hasMalformedMetadata
    ? "malformed_client_form_metadata"
    : "unsupported_component_types"
  const failureKey = JSON.stringify([
    processName,
    stepPath,
    todoId,
    failureReason,
    unsupportedTypes,
  ])
  const reportedFailureKeysRef = useRef(new Set<string>())

  useEffect(() => {
    if (
      reportedFailureKeysRef.current.has(failureKey) ||
      activePlugins.length === 0
    ) {
      return
    }

    reportedFailureKeysRef.current.add(failureKey)
    reportClientException(
      activePlugins,
      new Error("Public form client metadata is unsupported or malformed."),
      {
        public_form_action: "fail-closed",
        public_form_failure_reason: failureReason,
        public_form_process_name: processName,
        public_form_step_path: stepPath,
        public_form_todo_id: todoId,
        public_form_unsupported_component_types: unsupportedTypes,
      },
    )
  }, [
    activePlugins,
    failureKey,
    failureReason,
    processName,
    stepPath,
    todoId,
    unsupportedTypes,
  ])

  return (
    <PublicTodoStateContent
      title="This form cannot be opened here"
      description={`This public form contains unsupported fields (${unsupportedTypes.join(
        ", ",
      )}). Contact the sender for another way to complete it.`}
    />
  )
}

const publicTodoClientError = (error: unknown, fallback: string): Error => {
  if (error instanceof Error) {
    return error
  }

  return new Error(fallback)
}

const publicTodoResponseStatus = (error: Error): number | null =>
  error instanceof PublicTodoClientRequestError ? error.responseStatus : null

const reportPublicTodoClientError = (
  activePlugins: ActiveFrontendClientPlugins,
  error: unknown,
  properties: Record<string, unknown>,
): void => {
  const normalizedError = publicTodoClientError(
    error,
    "Public form request failed.",
  )

  reportClientException(activePlugins, normalizedError, {
    ...properties,
    public_form_response_status: publicTodoResponseStatus(normalizedError),
  })
}

const reportAndThrowPublicTodoClientError = (
  activePlugins: ActiveFrontendClientPlugins,
  error: unknown,
  properties: Record<string, unknown>,
): never => {
  reportPublicTodoClientError(activePlugins, error, properties)
  throw error
}

const rejectDependentPublicTodoLookup = async (): Promise<
  LookupSuggestion[]
> => {
  throw new Error("Dependent lookup fields are not available in public forms.")
}

const freshLinkErrorMessage = (body: FreshLinkResponse | null): string =>
  body?.error ?? "Unable to request a fresh link."

const freshLinkTodoStatus = (
  body: FreshLinkResponse | null,
): PublicTodoStatus | undefined => body?.todo?.status

const pendingPublicTodoLookups = new Map<string, Promise<LookupSuggestion[]>>()
// In-flight request dedupe only; entries are removed when each request settles.
const pendingPublicTodoCalendarSlots = new Map<
  string,
  Promise<CalendarSlotItem[]>
>()

const requestPublicTodoLookup = async (
  body: Record<string, unknown>,
): Promise<LookupSuggestion[]> => {
  const lookupKey = JSON.stringify(body)
  const pendingLookup = pendingPublicTodoLookups.get(lookupKey)

  if (pendingLookup) {
    return pendingLookup
  }

  const lookup = requestPublicTodoLookupUncached(body).finally(() => {
    pendingPublicTodoLookups.delete(lookupKey)
  })
  pendingPublicTodoLookups.set(lookupKey, lookup)

  return lookup
}

const requestPublicTodoLookupUncached = async (
  body: Record<string, unknown>,
): Promise<LookupSuggestion[]> => {
  const response = await fetch("/api/public/to-dos/lookup", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  })

  const payload = (await response
    .json()
    .catch(() => null)) as LookupResponse | null

  if (!response.ok) {
    throw new PublicTodoClientRequestError(
      payload?.error ?? "Unable to load lookup suggestions. Please try again.",
      response.status,
    )
  }

  return Array.isArray(payload?.items) ? payload.items : []
}

const requestPublicTodoCalendarSlots = async (
  body: Record<string, unknown>,
): Promise<CalendarSlotItem[]> => {
  const slotsKey = JSON.stringify(body)
  const pendingSlots = pendingPublicTodoCalendarSlots.get(slotsKey)

  if (pendingSlots) {
    return pendingSlots
  }

  const slots = requestPublicTodoCalendarSlotsUncached(body).finally(() => {
    pendingPublicTodoCalendarSlots.delete(slotsKey)
  })
  pendingPublicTodoCalendarSlots.set(slotsKey, slots)

  return slots
}

const requestPublicTodoCalendarSlotsUncached = async (
  body: Record<string, unknown>,
): Promise<CalendarSlotItem[]> => {
  const response = await fetch("/api/public/to-dos/calendar-slots", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  })

  const payload = (await response
    .json()
    .catch(() => null)) as CalendarSlotsResponse | null

  if (!response.ok) {
    throw new PublicTodoClientRequestError(
      payload?.error ?? "Unable to load calendar slots. Please try again.",
      response.status,
    )
  }

  return Array.isArray(payload?.items) ? payload.items : []
}

export function PublicTodoClient({
  token,
  todoId,
  submittedTitle,
  formMetadata,
}: PublicTodoClientProps) {
  const activePlugins = useActiveFrontendClientPlugins()
  const [submittedMessage, setSubmittedMessage] = useState<string | null>(null)
  const [terminalStatus, setTerminalStatus] = useState<Exclude<
    PublicTodoStatus,
    "ACTIVE" | "COMPLETED"
  > | null>(null)
  const lookupService = useMemo<LookupService>(
    () => ({
      fetchSuggestions: async (_stepPath, field, filter, limit) => {
        try {
          return await requestPublicTodoLookup({ token, field, filter, limit })
        } catch (error) {
          return reportAndThrowPublicTodoClientError(activePlugins, error, {
            public_form_action: "lookup",
            public_form_field: field,
            public_form_process_name: formMetadata.processName,
            public_form_step_path: formMetadata.stepPath,
            public_form_todo_id: todoId,
          })
        }
      },
      fetchDependentSuggestions: rejectDependentPublicTodoLookup,
      fetchCalendarSlots: async (_stepPath, field) => {
        try {
          return await requestPublicTodoCalendarSlots({ token, field })
        } catch (error) {
          return reportAndThrowPublicTodoClientError(activePlugins, error, {
            public_form_action: "calendar_slots",
            public_form_field: field,
            public_form_process_name: formMetadata.processName,
            public_form_step_path: formMetadata.stepPath,
            public_form_todo_id: todoId,
          })
        }
      },
    }),
    [
      activePlugins,
      formMetadata.processName,
      formMetadata.stepPath,
      todoId,
      token,
    ],
  )
  const unsupportedTypes = useMemo(
    () => publicTodoUnsupportedMetadataTypes(formMetadata),
    [formMetadata],
  )

  if (submittedMessage) {
    return (
      <PublicTodoStateContent
        eyebrow="Submitted"
        title={submittedTitle}
        description={submittedMessage}
      />
    )
  }

  if (terminalStatus) {
    const copy = publicTodoStateCopy(terminalStatus)
    return <PublicTodoStateContent {...copy} />
  }

  if (unsupportedTypes.length > 0) {
    return (
      <UnsupportedPublicTodoState
        activePlugins={activePlugins}
        processName={formMetadata.processName}
        stepPath={formMetadata.stepPath}
        todoId={todoId}
        unsupportedTypes={unsupportedTypes}
      />
    )
  }

  const handleSubmit = async (
    values: Record<string, unknown>,
  ): Promise<FieldError[] | undefined> => {
    let response: Response

    try {
      response = await fetch("/api/public/to-dos/complete", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ token, values }),
      })
    } catch (error) {
      reportPublicTodoClientError(activePlugins, error, {
        public_form_action: "complete",
        public_form_process_name: formMetadata.processName,
        public_form_step_path: formMetadata.stepPath,
        public_form_todo_id: todoId,
      })

      return [
        {
          field: "",
          message: "Unable to submit this form. Please try again.",
        },
      ]
    }

    const body = (await response
      .json()
      .catch(() => null)) as SubmitResponse | null

    if (response.ok) {
      const status = publicTodoTerminalStatusFromResult(body?.todo)
      if (status === "COMPLETED") {
        setSubmittedMessage(
          body?.todo?.completionMessage ?? "Successfully submitted.",
        )
      } else {
        setTerminalStatus(status)
      }
      return undefined
    }

    if (Array.isArray(body?.errors)) {
      return body.errors
    }

    const message =
      body?.error ?? "Unable to submit this form. Please try again."
    reportPublicTodoClientError(
      activePlugins,
      new PublicTodoClientRequestError(message, response.status),
      {
        public_form_action: "complete",
        public_form_process_name: formMetadata.processName,
        public_form_step_path: formMetadata.stepPath,
        public_form_todo_id: todoId,
      },
    )

    return [
      {
        field: "",
        message,
      },
    ]
  }

  const renderActions = (context: FormActionsContext) => (
    <div className="flex justify-end border-t border-slate-200 pt-6">
      <button
        type="submit"
        className="rounded-full bg-slate-950 px-6 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {context.formState.isSubmitting ? "Submitting..." : "Submit"}
      </button>
    </div>
  )

  const form = dynamicForm({
    // The shared form renderer persists drafts by key. Use the todo id instead
    // of the capability token so localStorage never stores the bearer token.
    draftId: `public-todo-${todoId}`,
    formDefinition: formMetadata.formDefinition,
    defaultValues: publicTodoDefaultValues(formMetadata.defaultValues),
    enableProviderUserLookup: false,
    handleCancel: () => undefined,
    handleSubmit,
    jsonSchema: publicTodoJsonSchema(formMetadata.jsonSchema),
    renderActions,
    stepPath: formMetadata.stepPath,
  })
  const title = formMetadata.publicFormTitle ?? formMetadata.processName
  const description =
    formMetadata.publicFormDescription ??
    "Submit this form to continue the process."

  return (
    <>
      <div className="mb-8 space-y-2">
        <h1 className="text-3xl font-semibold text-slate-950">{title}</h1>
        <p className="text-sm leading-6 text-slate-600">{description}</p>
      </div>
      <LookupProvider value={lookupService}>{form}</LookupProvider>
    </>
  )
}

export function ExpiredPublicTodoClient({ token }: { readonly token: string }) {
  const activePlugins = useActiveFrontendClientPlugins()
  const [status, setStatus] = useState<
    "idle" | "sent" | "completed" | "unavailable"
  >("idle")
  const [error, setError] = useState<string | null>(null)
  const [isPending, setIsPending] = useState(false)

  const requestFreshLink = async () => {
    setIsPending(true)
    setError(null)

    try {
      const response = await fetch("/api/public/to-dos/request-fresh-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      })
      const body = (await response
        .json()
        .catch(() => null)) as FreshLinkResponse | null

      if (!response.ok) {
        const message = freshLinkErrorMessage(body)
        reportPublicTodoClientError(
          activePlugins,
          new PublicTodoClientRequestError(message, response.status),
          { public_form_action: "request-fresh-link" },
        )
        setError(message)
      } else {
        const todoStatus = freshLinkTodoStatus(body)
        if (todoStatus === "COMPLETED") {
          setStatus("completed")
        } else if (todoStatus === "UNAVAILABLE") {
          setStatus("unavailable")
        } else {
          setStatus("sent")
        }
      }
    } catch (error) {
      reportPublicTodoClientError(activePlugins, error, {
        public_form_action: "request-fresh-link",
      })
      setError("Unable to request a fresh link. Please try again.")
    }
    setIsPending(false)
  }

  if (status === "completed") {
    return <PublicTodoStateContent {...publicTodoStateCopy("COMPLETED")} />
  }

  if (status === "unavailable") {
    return <PublicTodoStateContent {...publicTodoStateCopy("UNAVAILABLE")} />
  }

  return (
    <>
      <p className="text-sm font-semibold uppercase tracking-[0.18em] text-emerald-700">
        Process Focus
      </p>
      <h1 className="mt-3 text-3xl font-semibold text-slate-950">
        This link has expired
      </h1>
      <p className="mt-3 text-base leading-7 text-slate-600">
        {status === "sent"
          ? "We sent a fresh link to the current recipient for this form."
          : "Request a fresh link if you still need to complete this form."}
      </p>
      {error ? <p className="mt-4 text-sm text-red-700">{error}</p> : null}
      {status === "idle" ? (
        <button
          type="button"
          onClick={requestFreshLink}
          disabled={isPending}
          className="mt-6 rounded-full bg-slate-950 px-6 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isPending ? "Requesting..." : "Email me a fresh link"}
        </button>
      ) : null}
    </>
  )
}
