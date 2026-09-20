"use client"

import {
  type PublicKeyCredentialCreationOptionsJSON,
  startRegistration,
} from "@simplewebauthn/browser"
import { useCallback, useEffect, useState } from "react"
import { Button } from "@pf/shadcn-components"

const INVALID_LINK_MESSAGE =
  "This registration link is no longer valid. Ask an administrator for a new Registration Link."

declare global {
  interface Window {
    __PF_REGISTRATION_LINK_TOKEN?: string
  }
}

type PageState =
  | { kind: "loading" }
  | { kind: "signed_in" }
  | { kind: "ready"; email: string }
  | { kind: "invalid"; message: string }
  | { kind: "registering"; email: string }
  | { kind: "error"; email: string; message: string }

interface RegisterPasskeyClientProps {
  readonly isSignedIn: boolean
}

/**
 * Module-scoped token survives React Strict Mode remounts. Populated from the
 * layout's early scrub script (`window.__PF_REGISTRATION_LINK_TOKEN`) or a
 * last-chance fragment read if the script did not run.
 */
let moduleCapturedToken: string | null | undefined

/**
 * Capture the Registration Link bearer once per page load. Prefer the value
 * stashed by the layout scrub script (runs before hydration). Always scrub any
 * remaining fragment. Subsequent calls return the same captured value.
 */
const captureRegistrationLinkTokenOnce = (): string | null => {
  if (typeof window === "undefined") return null
  if (moduleCapturedToken !== undefined) {
    return moduleCapturedToken
  }

  let token: string | null = null
  if (typeof window.__PF_REGISTRATION_LINK_TOKEN === "string") {
    token = window.__PF_REGISTRATION_LINK_TOKEN.trim() || null
    // Clear the one-shot stash so a later navigation cannot re-read it.
    Reflect.deleteProperty(window, "__PF_REGISTRATION_LINK_TOKEN")
  }

  // Last chance if the inline script did not run (tests, unusual loaders).
  if (!token) {
    const hash = window.location.hash.startsWith("#")
      ? window.location.hash.slice(1)
      : window.location.hash
    if (hash) {
      const params = new URLSearchParams(hash)
      const fromHash = params.get("token")
      token = fromHash?.trim() ? fromHash.trim() : null
    }
  }

  // Always scrub any remaining fragment.
  if (window.location.hash) {
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.search}`,
    )
  }

  moduleCapturedToken = token
  return moduleCapturedToken
}

export function RegisterPasskeyClient({
  isSignedIn,
}: RegisterPasskeyClientProps) {
  const [state, setState] = useState<PageState>(() =>
    isSignedIn ? { kind: "signed_in" } : { kind: "loading" },
  )

  useEffect(() => {
    // Capture during the first client effect so SSR and remount share one value.
    const token = captureRegistrationLinkTokenOnce()

    if (isSignedIn) {
      setState({ kind: "signed_in" })
      return
    }

    let cancelled = false

    const exchange = async () => {
      if (!token) {
        if (!cancelled) {
          setState({ kind: "invalid", message: INVALID_LINK_MESSAGE })
        }
        return
      }

      try {
        const response = await fetch("/api/auth/passkey/registration-session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
          credentials: "include",
        })
        const data = (await response.json().catch(() => ({}))) as {
          email?: string
          error?: string
          message?: string
        }

        if (cancelled) return

        if (response.status === 403 && data.error === "signed_in") {
          setState({ kind: "signed_in" })
          return
        }

        if (!response.ok || !data.email) {
          setState({
            kind: "invalid",
            message: data.error ?? INVALID_LINK_MESSAGE,
          })
          return
        }

        setState({ kind: "ready", email: data.email })
      } catch {
        if (!cancelled) {
          setState({ kind: "invalid", message: INVALID_LINK_MESSAGE })
        }
      }
    }

    void exchange()
    return () => {
      cancelled = true
    }
  }, [isSignedIn])

  const handleCreatePasskey = useCallback(async () => {
    if (state.kind !== "ready" && state.kind !== "error") return
    const email = state.email
    setState({ kind: "registering", email })

    try {
      // Start OAuth authorisation without a caller-controlled redirect.
      const startResponse = await fetch("/api/auth/passkey/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
        credentials: "include",
      })
      if (!startResponse.ok) {
        const data = (await startResponse.json().catch(() => ({}))) as {
          error?: string
        }
        throw new Error(data.error || "Failed to start registration")
      }

      // Registration options derive email from the Registration Session cookie.
      const optionsResponse = await fetch("/api/auth/passkey/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
        credentials: "include",
      })
      if (!optionsResponse.ok) {
        const data = (await optionsResponse.json().catch(() => ({}))) as {
          error?: string
        }
        throw new Error(data.error || INVALID_LINK_MESSAGE)
      }

      const { challengeId, options } = (await optionsResponse.json()) as {
        challengeId: string
        options: PublicKeyCredentialCreationOptionsJSON
      }

      const attestation = await startRegistration({ optionsJSON: options })

      const verifyResponse = await fetch("/api/auth/passkey/register-verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeId, response: attestation }),
        credentials: "include",
      })
      const verifyData = (await verifyResponse.json().catch(() => ({}))) as {
        success?: boolean
        redirectUrl?: string
        error?: string
      }

      if (!verifyResponse.ok) {
        throw new Error(verifyData.error || "Registration verification failed")
      }

      // Application home only — never a caller-controlled target.
      window.location.href = verifyData.redirectUrl || "/"
    } catch (err) {
      if (err instanceof Error && err.name === "NotAllowedError") {
        setState({
          kind: "error",
          email,
          message: "Registration was cancelled. You can try again.",
        })
        return
      }
      setState({
        kind: "error",
        email,
        message: err instanceof Error ? err.message : "Registration failed",
      })
    }
  }, [state])

  if (state.kind === "loading") {
    return (
      <div className="text-center space-y-4">
        <h1 className="text-2xl font-bold">Create a passkey</h1>
        <p className="text-muted-foreground">Checking registration link…</p>
      </div>
    )
  }

  if (state.kind === "signed_in") {
    return (
      <div className="text-center space-y-4">
        <h1 className="text-2xl font-bold">Sign out to continue</h1>
        <p className="text-muted-foreground">
          You are already signed in. Sign out before using a Registration Link
          to create a passkey for an Invitation.
        </p>
        <Button asChild>
          <a href="/api/auth/logout">Sign out</a>
        </Button>
      </div>
    )
  }

  if (state.kind === "invalid") {
    return (
      <div className="text-center space-y-4">
        <h1 className="text-2xl font-bold">Registration unavailable</h1>
        <p className="text-muted-foreground" role="alert">
          {state.message}
        </p>
      </div>
    )
  }

  const email =
    state.kind === "ready" ||
    state.kind === "registering" ||
    state.kind === "error"
      ? state.email
      : ""

  return (
    <div className="space-y-6">
      <div className="text-center space-y-2">
        <h1 className="text-2xl font-bold">Create a passkey</h1>
        <p className="text-muted-foreground">
          Create a passkey for{" "}
          <span className="font-medium text-foreground">{email}</span>
        </p>
      </div>

      {state.kind === "error" ? (
        <p className="text-sm text-destructive text-center" role="alert">
          {state.message}
        </p>
      ) : null}

      <Button
        className="w-full"
        onClick={() => void handleCreatePasskey()}
        disabled={state.kind === "registering"}
      >
        {state.kind === "registering" ? "Creating passkey…" : "Create passkey"}
      </Button>
    </div>
  )
}
