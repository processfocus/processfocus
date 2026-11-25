"use client"

import { useRouter } from "next/navigation"
import {
  type ReactNode,
  createContext,
  use,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { LookupProvider, type LookupService } from "@pf/form"
import { AnonymousStartForm } from "@/components/anonymous-start-form"
import type { AnonymousPageData } from "@/lib/anonymous-page-server"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

function usePageSession() {
  const [revision, setRevision] = useState(0)
  const [message, setMessage] = useState("")
  const [completed, setCompleted] = useState(false)
  const [showSuccess, setShowSuccess] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const activeSubmission = useRef(false)
  const openedVisit = useRef<string | null>(null)
  return {
    revision,
    setRevision,
    message,
    setMessage,
    completed,
    setCompleted,
    showSuccess,
    setShowSuccess,
    isSubmitting,
    setIsSubmitting,
    activeSubmission,
    openedVisit,
  }
}

const PageSession = createContext<ReturnType<typeof usePageSession> | null>(
  null,
)

// This layout-owned state survives form unmount/Activity cleanup on browser Back.
export function AnonymousPageSession({ children }: { children: ReactNode }) {
  const session = usePageSession()
  useEffect(() => {
    if (!session.showSuccess) return
    const timeout = window.setTimeout(() => session.setShowSuccess(false), 5000)
    return () => window.clearTimeout(timeout)
  }, [session.showSuccess, session.setShowSuccess])
  return <PageSession value={session}>{children}</PageSession>
}

export function AnonymousPageClient({
  address,
  page,
  routeView,
}: {
  address: string
  page: AnonymousPageData
  routeView: "start" | "form"
}) {
  const session = use(PageSession)
  if (!session) throw new Error("Anonymous Page session is missing")
  const {
    revision,
    setRevision,
    message,
    setMessage,
    completed,
    setCompleted,
    showSuccess,
    setShowSuccess,
    isSubmitting,
    setIsSubmitting,
    activeSubmission,
    openedVisit,
  } = session
  const router = useRouter()
  const startPath = `/public/start/${encodeURIComponent(address)}`
  const view = completed ? "complete" : routeView
  const startButton = useRef<HTMLButtonElement>(null)
  const formHeading = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    if (isSubmitting) return
    if (view === "form") formHeading.current?.focus()
    else if (view === "start") startButton.current?.focus()
  }, [view, isSubmitting])

  useEffect(() => {
    if (view === "start" && showSuccess) {
      window.scrollTo({ top: 0, left: 0, behavior: "instant" })
    }
  }, [view, showSuccess])

  const endpoint = `/api/public/start/${encodeURIComponent(address)}`
  const draftId = `anonymous-page-${page.stepPath}`

  function returnToStart() {
    setMessage("")
    setShowSuccess(false)
    localStorage.removeItem(draftId)
    if (
      openedVisit.current === window.location.search &&
      openedVisit.current !== null
    ) {
      router.back()
    } else {
      router.replace(startPath)
    }
    openedVisit.current = null
  }

  const lookup = useMemo<LookupService>(() => {
    // Refresh choices after a rejection while retaining field-addressable errors.
    void revision
    const request = async (
      field: string,
      filter: string,
      limit: number,
      selectedValue?: string,
    ) => {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "lookup",
          field,
          filter,
          limit,
          selectedValue,
        }),
      })
      const body: unknown = await response.json()
      if (!response.ok || !isRecord(body) || !Array.isArray(body["items"]))
        throw new Error("Unable to load choices. Please try again.")
      return body["items"].flatMap((item: unknown) =>
        isRecord(item) &&
        typeof item["value"] === "string" &&
        typeof item["label"] === "string"
          ? [
              {
                value: item["value"],
                label: item["label"],
                ...(typeof item["searchText"] === "string" && {
                  searchText: item["searchText"],
                }),
              },
            ]
          : [],
      )
    }
    return {
      fetchSuggestions: async (_stepPath, field, filter, limit) =>
        request(field, filter, limit),
      resolveSelection: async (_stepPath, field, value) =>
        (await request(field, "", 1, value))[0] ?? null,
      search: async (_stepPath, field, filter, requestedLimit) => {
        const limit = Math.max(1, Math.min(requestedLimit, 99))
        const items = await request(field, filter, limit + 1)
        return { items: items.slice(0, limit), hasMore: items.length > limit }
      },
      fetchCalendarSlots: async () => {
        throw new Error("Calendar slots are not available on this page")
      },
      fetchDependentSuggestions: async () => {
        throw new Error("Dependent lookups are not available on this page")
      },
    }
  }, [endpoint, revision])

  async function handleSubmit(values: Record<string, unknown>) {
    if (activeSubmission.current) {
      return [{ field: "", message: "A submission is already in progress." }]
    }
    activeSubmission.current = true
    setIsSubmitting(true)
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "submit", values }),
      })
      const body: unknown = await response.json()
      if (!response.ok) {
        const errors =
          isRecord(body) && Array.isArray(body["errors"]) ? body["errors"] : []
        const fieldErrors = errors.flatMap((error: unknown) =>
          isRecord(error) &&
          typeof error["field"] === "string" &&
          typeof error["message"] === "string"
            ? [{ field: error["field"], message: error["message"] }]
            : [],
        )
        setMessage("")
        setRevision((value) => value + 1)
        return fieldErrors.length
          ? fieldErrors
          : [{ field: "", message: "Unable to submit. Please try again." }]
      } else {
        setMessage("")
        setCompleted(page.afterSubmit !== "restart")
        router.replace(startPath)
        openedVisit.current = null
        setShowSuccess(page.afterSubmit === "restart")
      }
      // Clear the successful draft and refresh choices for the next visit.
      localStorage.removeItem(draftId)
      setRevision((value) => value + 1)
    } catch {
      if (window.location.pathname === `${startPath}/form`) {
        return [{ field: "", message: "Unable to submit. Please try again." }]
      }
      setMessage("Unable to submit. Please try again.")
    } finally {
      activeSubmission.current = false
      setIsSubmitting(false)
    }
    return undefined
  }

  return (
    <>
      {view === "start" ? (
        <button
          ref={startButton}
          type="button"
          disabled={isSubmitting}
          onClick={() => {
            setShowSuccess(false)
            setMessage("")
            // router.push does not prefetch. A new search key on every opening
            // also bypasses already visited route data, including after Back.
            const visit = `?visit=${crypto.randomUUID()}`
            openedVisit.current = visit
            router.push(`${startPath}/form${visit}`)
          }}
          className="rounded-md bg-primary px-6 py-3 text-xl font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50"
        >
          {isSubmitting ? "Submitting…" : page.name}
        </button>
      ) : (
        <h1
          ref={formHeading}
          tabIndex={-1}
          className="mb-6 text-2xl font-semibold"
        >
          {page.name}
        </h1>
      )}
      <div role="status" aria-live="polite" aria-atomic="true">
        {showSuccess ? (
          <p className="fixed right-4 bottom-4 left-4 z-50 rounded-md border border-green-300 bg-green-50 px-6 py-4 text-green-950 shadow-lg sm:left-auto">
            Submitted successfully.
          </p>
        ) : null}
      </div>
      {view === "complete" ? <p>Submitted successfully.</p> : null}
      {message ? (
        <p role="status" className="mb-4">
          {message}
        </p>
      ) : null}
      {view === "form" ? (
        <fieldset disabled={isSubmitting} aria-busy={isSubmitting}>
          <LookupProvider value={lookup}>
            <AnonymousStartForm
              formPath={page.formPath}
              draftId={draftId}
              defaultValues={page.defaultValues}
              requestData={page.requestData}
              pluginConfiguration={page.pluginConfiguration}
              stepPath={page.stepPath}
              onSubmit={handleSubmit}
            >
              {({ formState }) => (
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <button
                    type="button"
                    disabled={isSubmitting || formState.isSubmitting}
                    onClick={returnToStart}
                    className="rounded-md border border-input bg-background px-6 py-3 text-foreground transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50"
                  >
                    Back
                  </button>
                  <div className="ml-auto flex flex-wrap justify-end gap-3">
                    <button
                      type="button"
                      disabled={isSubmitting || formState.isSubmitting}
                      onClick={returnToStart}
                      className="rounded-md border border-input bg-background px-6 py-3 text-foreground transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={isSubmitting || formState.isSubmitting}
                      className="rounded-md bg-primary px-6 py-3 text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50"
                    >
                      {isSubmitting || formState.isSubmitting
                        ? "Submitting…"
                        : "Submit"}
                    </button>
                  </div>
                </div>
              )}
            </AnonymousStartForm>
          </LookupProvider>
        </fieldset>
      ) : null}
    </>
  )
}
