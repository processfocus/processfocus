"use client"

import { useEffect, useRef, useTransition } from "react"
import { PublicFormBrandingCard } from "./public-form-branding-card"
import { usePublicFormBranding } from "./public-form-branding-context"
import { useActiveFrontendClientPlugins } from "@/components/frontend-client-plugin-provider"
import { reportClientException } from "@/lib/client-plugin-error-reporting"

export default function PublicFormError({
  error,
  retry,
}: {
  readonly error: Error
  readonly retry: () => void
}) {
  const [isPending, startTransition] = useTransition()
  const activePlugins = useActiveFrontendClientPlugins()
  const publicFormBranding = usePublicFormBranding()
  const reportedRef = useRef(false)

  useEffect(() => {
    if (reportedRef.current || activePlugins.length === 0) {
      return
    }

    reportClientException(activePlugins, error, {
      public_form_action: "initial-load",
      public_form_pathname: "/public/form/[token]",
    })
    reportedRef.current = true
  }, [activePlugins, error])

  return (
    <main className="min-h-screen bg-slate-50 px-4 py-10 text-slate-950 sm:px-6 lg:px-8">
      <section
        aria-labelledby="public-form-error-title"
        className="mx-auto w-full max-w-2xl"
      >
        <PublicFormBrandingCard branding={publicFormBranding} className="p-8">
          <h1
            className="mt-3 text-3xl font-semibold text-slate-950"
            id="public-form-error-title"
          >
            This form is temporarily unavailable
          </h1>
          <p className="mt-3 text-base leading-7 text-slate-600">
            We could not load this form. Please try again or contact the sender
            if the problem continues.
          </p>
          <button
            type="button"
            className="mt-6 rounded-md bg-slate-950 px-4 py-2 font-medium text-white focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50"
            disabled={isPending}
            aria-busy={isPending}
            onClick={() => startTransition(retry)}
          >
            {isPending ? "Trying again…" : "Try again"}
          </button>
        </PublicFormBrandingCard>
      </section>
    </main>
  )
}
