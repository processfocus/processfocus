"use client"

import { useState } from "react"
import { Button } from "@pf/shadcn-components"
import { Input } from "@/components/ui/input"
import { getValidRedirect } from "@/lib/auth/redirect"
import { environmentUnavailableMessage } from "@/lib/auth/session-admission-message"

export function SecretLoginForm({
  enabled = false,
  redirect,
}: {
  enabled?: boolean
  redirect?: string | undefined
}) {
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  if (!enabled) return null
  return (
    <details className="rounded-lg border p-4">
      <summary className="cursor-pointer text-sm font-medium">
        Log in with a secret
      </summary>
      <form
        method="post"
        action="/api/auth/delegation"
        className="mt-4 space-y-3"
        autoComplete="off"
        onSubmit={async (event) => {
          event.preventDefault()
          if (pending) return
          const form = event.currentTarget
          const secret = new FormData(form).get("secret")
          form.reset()
          setPending(true)
          setFailed(null)
          try {
            const response = await fetch("/api/auth/delegation", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ secret }),
              credentials: "same-origin",
              cache: "no-store",
            })
            if (response.status === 503) {
              const result: unknown = await response.json()
              if (
                typeof result === "object" &&
                result !== null &&
                "error" in result &&
                result.error === "environment_unavailable"
              ) {
                setFailed(environmentUnavailableMessage)
                setPending(false)
                return
              }
            }
            if (response.ok) {
              const destination = new URL(
                getValidRedirect(redirect),
                window.location.origin,
              )
              window.location.replace(
                destination.origin === window.location.origin
                  ? destination.href
                  : `${window.location.origin}/`,
              )
              return
            }
          } catch {
            // Errors may contain request details. Show only fixed safe copy.
          }
          setFailed(
            "Unable to log in with this secret. It may be invalid or delegated access may be unavailable.",
          )
          setPending(false)
        }}
      >
        <label htmlFor="login-secret" className="text-sm">
          Delegation Secret
        </label>
        <Input
          id="login-secret"
          name="secret"
          type="password"
          required
          maxLength={48}
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="none"
          className="ph-no-capture"
          data-private="true"
          disabled={pending}
        />
        {failed && (
          <p role="alert" className="text-sm text-destructive">
            {failed}
          </p>
        )}
        <Button type="submit" disabled={pending}>
          {pending ? "Logging in..." : "Log in with a secret"}
        </Button>
      </form>
    </details>
  )
}
