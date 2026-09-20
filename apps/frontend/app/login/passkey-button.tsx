"use client"

import { startRegistration } from "@simplewebauthn/browser"
import { useState } from "react"
import { Button } from "@pf/shadcn-components"
import { authenticateWithPasskey } from "@/lib/auth/verify-passkey"

type PasskeyMode = "idle" | "register"

interface PasskeyButtonProps {
  redirect?: string | undefined
  /**
   * When false (invite-only), hide self-registration and explain that
   * first-time users must use their Registration Link.
   */
  openRegistration?: boolean
  purpose?: "signin" | "reauthenticate"
}

const throwPasskeyResponseError = (
  data: { error?: string },
  fallback: string,
): never => {
  throw new Error(data.error || fallback)
}

export function PasskeyButton({
  redirect,
  openRegistration = false,
  purpose = "signin",
}: PasskeyButtonProps) {
  const [mode, setMode] = useState<PasskeyMode>("idle")
  const [email, setEmail] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  const handleRegister = async () => {
    if (!email.trim()) {
      setError("Please enter your email")
      return
    }

    setError(null)
    setIsLoading(true)

    try {
      // Step 1: Start the OAuth flow to set up authorization state
      // This calls the auth server server-side and forwards the cookies
      const startResponse = await fetch("/api/auth/passkey/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ redirect }),
        credentials: "include",
      })

      if (!startResponse.ok) {
        const data = await startResponse.json()
        throwPasskeyResponseError(data, "Failed to start passkey flow")
      }

      // Step 2: Get registration options from the server
      const optionsResponse = await fetch("/api/auth/passkey/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
        credentials: "include",
      })

      if (!optionsResponse.ok) {
        const data = await optionsResponse.json()
        throwPasskeyResponseError(data, "Failed to get registration options")
      }

      const { challengeId, options } = await optionsResponse.json()

      // Step 4: Start the WebAuthn registration ceremony in the browser
      const attestation = await startRegistration({ optionsJSON: options })

      // Step 5: Verify the registration with the server
      const verifyResponse = await fetch("/api/auth/passkey/register-verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challengeId, response: attestation }),
        credentials: "include",
      })

      const verifyData = await verifyResponse.json()

      if (!verifyResponse.ok) {
        throwPasskeyResponseError(
          verifyData,
          "Registration verification failed",
        )
      }

      // Step 6: On success, redirect to the callback URL
      if (verifyData.redirectUrl) {
        window.location.href = verifyData.redirectUrl
      } else if (verifyData.success) {
        // Fallback: redirect to home
        window.location.href = "/"
      }
    } catch (err) {
      console.error("Passkey registration error:", err)
      if (err instanceof Error) {
        // Handle user cancellation
        if (err.name === "NotAllowedError") {
          setError("Registration was cancelled")
        } else {
          setError(err.message)
        }
      } else {
        setError("Registration failed")
      }
    }
    setIsLoading(false)
  }

  const handleAuthenticate = async () => {
    setError(null)
    setIsLoading(true)

    try {
      await authenticateWithPasskey({ redirect, purpose })
    } catch (err) {
      console.error("Passkey authentication error:", err)
      if (err instanceof Error) {
        // Browsers do not distinguish missing credentials, cancellation, and timeout.
        if (err.name === "NotAllowedError") {
          setError(
            "Couldn’t sign in with a passkey. Your device or security key may not have a passkey for this site, or the request was cancelled or timed out. Try the device or security key you used when setting up your passkey, or use another sign-in method.",
          )
        } else {
          setError(err.message)
        }
      } else {
        setError("Authentication failed")
      }
    }
    setIsLoading(false)
  }

  if (mode === "idle") {
    return (
      <div className="space-y-3">
        <Button
          type="button"
          onClick={handleAuthenticate}
          variant="outline"
          className="w-full"
          disabled={isLoading}
        >
          {isLoading
            ? "Please wait..."
            : purpose === "reauthenticate"
              ? "Authenticate again with Passkey"
              : "Sign in with Passkey"}
        </Button>
        {openRegistration ? (
          <Button
            onClick={() => setMode("register")}
            variant="ghost"
            className="w-full text-sm"
            disabled={isLoading}
          >
            Register a new Passkey
          </Button>
        ) : purpose === "signin" ? (
          <p className="text-center text-sm text-gray-600">
            First-time users must use their Registration Link.
          </p>
        ) : null}
        {error && (
          <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">
            {error}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <label htmlFor="passkey-email" className="text-sm font-medium">
          Email for new passkey
        </label>
        <input
          id="passkey-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="your@email.com"
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
          disabled={isLoading}
        />
      </div>

      {error && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="flex gap-2">
        <Button
          onClick={() => {
            setMode("idle")
            setError(null)
          }}
          variant="ghost"
          disabled={isLoading}
        >
          Back
        </Button>
        <Button
          onClick={handleRegister}
          className="flex-1"
          disabled={isLoading || !email.trim()}
        >
          {isLoading ? "Please wait..." : "Register Passkey"}
        </Button>
      </div>
    </div>
  )
}
