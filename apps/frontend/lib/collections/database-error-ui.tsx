"use client"

import { useState } from "react"

interface DatabaseErrorUIProps {
  error: Error
  onRetry: () => Promise<void>
}

export function DatabaseErrorUI({ error, onRetry }: DatabaseErrorUIProps) {
  const [isRetrying, setIsRetrying] = useState(false)

  const handleRetry = async () => {
    setIsRetrying(true)
    try {
      // onRetry() clears the database and reloads the page.
      // On success, window.location.reload() terminates the component.
      // No finally block needed—state reset only matters on error.
      await onRetry()
    } catch (retryError) {
      console.error("Retry failed:", retryError)
      setIsRetrying(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-md space-y-4 rounded-lg border-2 border-red-500 bg-white p-6 shadow-lg">
        <div className="space-y-2">
          <h2 className="text-xl font-semibold text-red-600">
            Database Initialization Failed
          </h2>
          <p className="text-sm text-gray-600">
            Retry clears the local database and reloads.
          </p>
        </div>

        <div
          role="alert"
          aria-live="assertive"
          className="rounded bg-red-50 p-3"
        >
          <p className="font-mono text-xs break-words text-red-800">
            {error.message}
          </p>
        </div>

        <div className="flex flex-col gap-2 pt-2">
          <button
            type="button"
            onClick={handleRetry}
            disabled={isRetrying}
            className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isRetrying ? "Retrying..." : "Retry"}
          </button>
        </div>
      </div>
    </div>
  )
}
