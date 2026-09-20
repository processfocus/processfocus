"use client"

import { ClientError, gql } from "graphql-request"
import { useRouter } from "next/navigation"
import { type FormEvent, useCallback, useEffect, useId, useState } from "react"
import { Button } from "@pf/shadcn-components"
import { Input } from "@/components/ui/input"
import { useGraphqlClient } from "@/lib/graphql/client-provider"

interface PublicCompletionCorrection {
  todoId: string
  processName: string
  stepName: string
  correctedEmail: string
  failureReason: string | null
}

interface CorrectionQueryResult {
  publicCompletionCorrection: PublicCompletionCorrection | null
}

interface CorrectionMutationResult {
  submitPublicCompletionCorrection: PublicCompletionCorrection
}

const correctionQuery = gql`
  query PublicCompletionCorrection($todoId: ID!) {
    publicCompletionCorrection(todoId: $todoId) {
      todoId
      processName
      stepName
      correctedEmail
      failureReason
    }
  }
`

const correctionMutation = gql`
  mutation SubmitPublicCompletionCorrection(
    $todoId: ID!
    $correctedEmail: String!
  ) {
    submitPublicCompletionCorrection(
      todoId: $todoId
      correctedEmail: $correctedEmail
    ) {
      todoId
      processName
      stepName
      correctedEmail
      failureReason
    }
  }
`

const validationErrorsFromClientError = (error: ClientError): string | null => {
  const gqlError = error.response.errors?.[0]
  if (gqlError?.extensions?.["code"] !== "InputValidationError") {
    return gqlError?.message ?? null
  }

  const errors = gqlError.extensions["errors"]
  if (!Array.isArray(errors)) return gqlError.message

  const correctedEmailError = errors.find(
    (item): item is { field: string; message: string } =>
      typeof item === "object" &&
      item !== null &&
      "field" in item &&
      item.field === "correctedEmail" &&
      "message" in item &&
      typeof item.message === "string",
  )

  return correctedEmailError?.message ?? gqlError.message
}

export function PublicCompletionCorrectionForm({
  todoId,
  fallbackStepName,
}: {
  todoId: string | undefined
  fallbackStepName: string
}) {
  const graphqlClient = useGraphqlClient()
  const router = useRouter()
  const emailId = useId()
  const [correction, setCorrection] =
    useState<PublicCompletionCorrection | null>(null)
  const [email, setEmail] = useState("")
  const [isLoading, setIsLoading] = useState(Boolean(todoId))
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function loadCorrection() {
      if (!todoId) {
        setError("No todo id was provided.")
        setIsLoading(false)
        return
      }

      try {
        const result = await graphqlClient.request<CorrectionQueryResult>(
          correctionQuery,
          { todoId },
        )
        if (!cancelled) {
          if (!result.publicCompletionCorrection) {
            setError("This todo is no longer available for correction.")
          } else {
            setCorrection(result.publicCompletionCorrection)
            setEmail(result.publicCompletionCorrection.correctedEmail)
          }
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "Unable to load correction details.",
          )
        }
      }
      if (!cancelled) setIsLoading(false)
    }

    void loadCorrection()

    return () => {
      cancelled = true
    }
  }, [graphqlClient, todoId])

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      if (!todoId) return

      setIsSubmitting(true)
      setError(null)
      try {
        await graphqlClient.request<CorrectionMutationResult>(
          correctionMutation,
          { todoId, correctedEmail: email },
        )
        router.push("/to-dos")
      } catch (submitError) {
        if (submitError instanceof ClientError) {
          setError(
            validationErrorsFromClientError(submitError) ??
              "Unable to submit correction.",
          )
        } else {
          setError(
            submitError instanceof Error
              ? submitError.message
              : "Unable to submit correction.",
          )
        }
      }
      setIsSubmitting(false)
    },
    [email, graphqlClient, router, todoId],
  )

  if (isLoading) {
    return <p className="text-sm text-slate-500">Loading correction...</p>
  }

  if (error && !correction) {
    return <p className="text-sm text-rose-600">{error}</p>
  }

  const title = correction?.stepName ?? fallbackStepName

  return (
    <form className="space-y-6" onSubmit={handleSubmit}>
      <div>
        <p className="text-sm font-medium text-slate-500 dark:text-slate-400">
          {correction?.processName ?? "Public completion"}
        </p>
        <h1 className="mt-2 text-3xl font-semibold text-slate-900 dark:text-slate-50">
          {title}
        </h1>
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
          Correct the recipient email. The external participant will receive a
          new invitation after submission.
        </p>
      </div>

      {correction?.failureReason && (
        <p className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          {correction.failureReason}
        </p>
      )}

      <div className="space-y-2">
        <label
          className="text-sm font-medium text-slate-700 dark:text-slate-200"
          htmlFor={emailId}
        >
          Corrected email
        </label>
        <Input
          id={emailId}
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
          autoComplete="email"
        />
      </div>

      {error && <p className="text-sm text-rose-600">{error}</p>}

      <div className="flex justify-end gap-3">
        <Button
          type="button"
          variant="outline"
          onClick={() => router.push("/to-dos")}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={isSubmitting || !todoId}>
          {isSubmitting ? "Sending..." : "Send new invitation"}
        </Button>
      </div>
    </form>
  )
}
