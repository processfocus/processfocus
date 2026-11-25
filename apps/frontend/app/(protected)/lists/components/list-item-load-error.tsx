"use client"

import { ClientError } from "graphql-request"
import { Button } from "@pf/shadcn-components"

export function ListItemLoadError({
  error,
  onRetry,
}: {
  error: unknown
  onRetry: () => unknown
}) {
  const diagnostics =
    error instanceof ClientError
      ? [...new Set(error.response.errors?.map((entry) => entry.message))].join(
          "\n",
        )
      : error instanceof Error
        ? error.message
        : ""
  const denied =
    error instanceof ClientError &&
    error.response.errors?.some(
      (entry) => entry.extensions?.["code"] === "NotAuthorized",
    )

  return (
    <div className="space-y-4" role="alert">
      <p className="text-sm text-rose-600 dark:text-rose-400">
        {denied
          ? "You do not have permission to access this item."
          : "Unable to load this item."}
      </p>
      {diagnostics ? (
        <details className="text-sm text-slate-600 dark:text-slate-400">
          <summary>Error details</summary>
          <p className="mt-2 whitespace-pre-wrap break-words">{diagnostics}</p>
        </details>
      ) : null}
      <Button
        onClick={() => {
          void onRetry()
        }}
      >
        Try Again
      </Button>
    </div>
  )
}
