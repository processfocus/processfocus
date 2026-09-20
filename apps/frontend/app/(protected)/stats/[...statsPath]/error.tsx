"use client"

import { useEffect, useTransition } from "react"

export default function StatsError({
  error,
  retry,
}: {
  readonly error: Error
  readonly retry: () => void
}) {
  const [isPending, startTransition] = useTransition()
  useEffect(() => {
    console.error("Stats page error", error)
  }, [error])

  return (
    <div className="container mx-auto py-6">
      <div className="rounded-lg bg-red-50 p-4 text-red-700 dark:bg-red-900/20 dark:text-red-400">
        <p className="font-medium">Unable to load this stats view</p>
        <p className="text-sm">Something went wrong. Please try again.</p>
        <button
          type="button"
          className="mt-4 rounded-md border border-current px-4 py-2 font-medium focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50"
          disabled={isPending}
          aria-busy={isPending}
          onClick={() => startTransition(retry)}
        >
          {isPending ? "Trying again…" : "Try again"}
        </button>
      </div>
    </div>
  )
}
