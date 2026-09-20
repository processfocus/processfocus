"use client"

import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react"
import {
  type CalendarSlotItem,
  type FieldError,
  type FormActionsContext,
  type JsonSchemaRoot,
  LookupProvider,
  type LookupService,
  type LookupSuggestion,
  dynamicForm,
} from "@pf/form"
import { useActiveFrontendClientPlugins } from "@/components/frontend-client-plugin-provider"
import { reportClientException } from "@/lib/client-plugin-error-reporting"
import {
  EMBED_EVENT_SOURCE,
  EMBED_EVENT_VERSION,
  type EmbedHostEvent,
  type EmbedHostEventType,
  type EmbedManifestEntry,
  buildEmbedStorageKey,
} from "@/lib/embed-manifest"

interface EmbedClientProps {
  entry: EmbedManifestEntry
}

interface EmbedLookupResponse {
  readonly items?: LookupSuggestion[]
  readonly error?: string
}

interface EmbedCalendarSlotsResponse {
  readonly items?: CalendarSlotItem[]
  readonly error?: string
}

interface EmbedHostRequestEvent {
  readonly source?: string
  readonly version?: number
  readonly event?: string
}

const EMBED_HOST_REQUEST_SOURCE = "processfocus-embed-host"
const EMBED_HOST_REQUEST_VERSION = 1

const getPostMessageTargetOrigin = (
  sites: readonly string[],
): string | undefined => {
  if (typeof document === "undefined" || document.referrer.length === 0) {
    return undefined
  }

  try {
    const referrerOrigin = new URL(document.referrer).origin
    return sites.includes(referrerOrigin) ||
      referrerOrigin === window.location.origin
      ? referrerOrigin
      : undefined
  } catch {
    return undefined
  }
}

const postHostEventPayload = (
  stepPath: string,
  event: EmbedHostEventType,
  extra?: Pick<EmbedHostEvent, "height">,
): EmbedHostEvent => ({
  source: EMBED_EVENT_SOURCE,
  version: EMBED_EVENT_VERSION,
  event,
  stepPath,
  ...(extra ?? {}),
})

const requestEmbedLookup = async (
  body: Record<string, unknown>,
): Promise<LookupSuggestion[]> => {
  const response = await fetch("/api/embed/lookup", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  })

  const payload = (await response
    .json()
    .catch(() => null)) as EmbedLookupResponse | null

  if (!response.ok) {
    throw new Error(
      payload?.error ?? "Unable to load lookup suggestions. Please try again.",
    )
  }

  return Array.isArray(payload?.items) ? payload.items : []
}

const requestEmbedCalendarSlots = async (
  body: Record<string, unknown>,
): Promise<CalendarSlotItem[]> => {
  const response = await fetch("/api/embed/lookup", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  })

  const payload = (await response
    .json()
    .catch(() => null)) as EmbedCalendarSlotsResponse | null

  if (!response.ok) {
    throw new Error(
      payload?.error ?? "Unable to load calendar slots. Please try again.",
    )
  }

  return Array.isArray(payload?.items) ? payload.items : []
}

const ThankYouState = ({
  processName,
  thankYou,
}: {
  processName: string
  thankYou: string
}) => {
  const paragraphs = thankYou
    .split(/\n\s*\n/g)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)

  return (
    <section className="space-y-4 rounded-3xl border border-emerald-200 bg-emerald-50 p-6 text-emerald-950 shadow-sm sm:p-8">
      <div className="space-y-2">
        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-emerald-700">
          Submitted
        </p>
        <h1 className="text-2xl font-semibold sm:text-3xl">{processName}</h1>
      </div>
      <div className="space-y-3 text-sm leading-6 text-emerald-900 sm:text-base">
        {paragraphs.length > 0 ? (
          paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)
        ) : (
          <p>Thank you. Your form has been submitted.</p>
        )}
      </div>
    </section>
  )
}

export default function EmbedClient({ entry }: EmbedClientProps) {
  const [isSubmitted, setIsSubmitted] = useState(false)
  const activePlugins = useActiveFrontendClientPlugins()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const lookupService = useMemo<LookupService>(
    () => ({
      fetchSuggestions: async (stepPath, field, filter, limit) =>
        requestEmbedLookup({ stepPath, field, filter, limit }),
      fetchDependentSuggestions: async (queryName, variables) =>
        requestEmbedLookup({
          stepPath: entry.stepPath,
          queryName,
          // The form walker passes dependent lookup variables as
          // { input: Record<string, string>, limit: number }.
          input: variables["input"],
          limit: variables["limit"],
        }),
      fetchCalendarSlots: async (stepPath, field) =>
        requestEmbedCalendarSlots({ stepPath, field }),
    }),
    [entry.stepPath],
  )

  const postHostEventToOrigin = useEffectEvent(
    (
      targetOrigin: string,
      event: EmbedHostEventType,
      extra?: Pick<EmbedHostEvent, "height">,
    ) => {
      if (typeof window === "undefined" || window.parent === window) {
        return
      }

      window.parent.postMessage(
        postHostEventPayload(entry.stepPath, event, extra),
        targetOrigin,
      )
    },
  )

  const postHostEvent = useEffectEvent(
    (event: EmbedHostEventType, extra?: Pick<EmbedHostEvent, "height">) => {
      const targetOrigin = getPostMessageTargetOrigin(entry.sites)
      if (!targetOrigin) {
        return
      }

      postHostEventToOrigin(targetOrigin, event, extra)
    },
  )

  useEffect(() => {
    const html = document.documentElement
    const searchParams = new URLSearchParams(window.location.search)
    const mode = searchParams.get("mode")
    const resolvedMode =
      mode === "light" || mode === "dark"
        ? mode
        : window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light"

    html.classList.remove("light", "dark")
    html.classList.add(resolvedMode)
    html.style.colorScheme = resolvedMode
    html.dataset["pfEmbed"] = "true"
    html.dataset["pfEmbedAlign"] =
      searchParams.get("align") === "left" ? "left" : "center"

    return () => {
      html.classList.remove("light", "dark")
      html.style.colorScheme = ""
      delete html.dataset["pfEmbed"]
      delete html.dataset["pfEmbedAlign"]
    }
  }, [])

  useEffect(() => {
    const element = containerRef.current
    if (!element || typeof ResizeObserver === "undefined") {
      return
    }

    const emitResize = () => {
      postHostEvent("resize", {
        height: Math.ceil(element.getBoundingClientRect().height),
      })
    }

    postHostEvent("ready")
    emitResize()

    const observer = new ResizeObserver(() => {
      emitResize()
    })
    observer.observe(element)

    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const handleMessage = (event: MessageEvent<EmbedHostRequestEvent>) => {
      if (
        !entry.sites.includes(event.origin) &&
        event.origin !== window.location.origin
      ) {
        return
      }

      const data = event.data
      if (
        !data ||
        data.source !== EMBED_HOST_REQUEST_SOURCE ||
        data.version !== EMBED_HOST_REQUEST_VERSION ||
        data.event !== "request-resize"
      ) {
        return
      }

      const element = containerRef.current
      if (!element) {
        return
      }

      postHostEventToOrigin(event.origin, "resize", {
        height: Math.ceil(element.getBoundingClientRect().height),
      })
    }

    window.addEventListener("message", handleMessage)
    return () => window.removeEventListener("message", handleMessage)
  }, [entry.sites])

  useEffect(() => {
    if (isSubmitted) {
      postHostEvent("submitted")
    }
  }, [isSubmitted])

  const handleSubmit = async (
    values: Record<string, unknown>,
  ): Promise<FieldError[] | undefined> => {
    const response = await fetch("/api/embed/submit", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ stepPath: entry.stepPath, values }),
    })

    const body = (await response.json().catch(() => null)) as {
      errors?: FieldError[]
      error?: string
    } | null

    if (response.ok) {
      setIsSubmitted(true)
      return undefined
    }

    if (body?.errors && Array.isArray(body.errors)) {
      return body.errors
    }

    const message =
      body?.error ?? "Unable to submit the form. Please try again."

    reportClientException(
      activePlugins,
      new Error(`Embedded form submit failed: ${message}`),
      {
        embed_process_name: entry.processName,
        embed_process_path: entry.processPath,
        embed_response_status: response.status,
        embed_step_path: entry.stepPath,
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
    <div className="flex justify-end">
      <button
        type="submit"
        className="rounded-full bg-slate-950 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {context.formState.isSubmitting ? "Submitting..." : "Submit"}
      </button>
    </div>
  )

  const form = dynamicForm({
    draftId: buildEmbedStorageKey(entry.stepPath),
    formDefinition: entry.formDefinition,
    defaultValues: entry.defaultValues,
    handleCancel: () => undefined,
    handleSubmit,
    jsonSchema: (entry.jsonSchema as JsonSchemaRoot | null) ?? null,
    renderActions,
    stepPath: entry.stepPath,
    enableProviderUserLookup: false,
  })

  return (
    <div
      ref={containerRef}
      className="pf-embed-container w-full max-w-3xl py-4 sm:py-6"
    >
      {isSubmitted ? (
        <ThankYouState
          processName={entry.processName}
          thankYou={entry.thankYou}
        />
      ) : (
        <section className="space-y-6">
          <div className="mb-6 space-y-2">
            <p className="text-muted-foreground text-xs font-semibold uppercase tracking-[0.18em]">
              Process Focus Form
            </p>
            <h1 className="text-foreground text-2xl font-semibold sm:text-3xl">
              {entry.processName}
            </h1>
          </div>
          <div className="pf-embed-form">
            <LookupProvider value={lookupService}>{form}</LookupProvider>
          </div>
        </section>
      )}
    </div>
  )
}
