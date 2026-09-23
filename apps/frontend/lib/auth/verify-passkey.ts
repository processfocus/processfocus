import {
  WebAuthnAbortService,
  startAuthentication,
} from "@simplewebauthn/browser"
import { environmentUnavailableMessage } from "./session-admission-message"

/** Run the existing OAuth/WebAuthn ceremony. Only the callback sets session cookies. */
export async function authenticateWithPasskey({
  redirect,
  purpose,
  inPlace = false,
  signal,
}: {
  redirect: string | undefined
  purpose: "signin" | "reauthenticate"
  inPlace?: boolean
  signal?: AbortSignal
}): Promise<void> {
  const start = await fetch("/api/auth/passkey/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect, purpose }),
    credentials: "include",
    ...(signal ? { signal } : {}),
  })
  if (!start.ok)
    throw new Error("Unable to start passkey verification. Please try again.")
  const optionsResponse = await fetch("/api/auth/passkey/auth-options", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    credentials: "include",
    ...(signal ? { signal } : {}),
  })
  if (!optionsResponse.ok)
    throw new Error("Unable to start passkey verification. Please try again.")
  const { challengeId, options } = await optionsResponse.json()
  signal?.throwIfAborted()
  const cancelCeremony = () => WebAuthnAbortService.cancelCeremony()
  signal?.addEventListener("abort", cancelCeremony, { once: true })
  let assertion: Awaited<ReturnType<typeof startAuthentication>>
  try {
    assertion = await startAuthentication({ optionsJSON: options })
  } finally {
    signal?.removeEventListener("abort", cancelCeremony)
  }
  signal?.throwIfAborted()
  const verify = await fetch("/api/auth/passkey/auth-verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ challengeId, response: assertion }),
    credentials: "include",
    ...(signal ? { signal } : {}),
  })
  const data: unknown = await verify.json()
  if (
    !verify.ok ||
    typeof data !== "object" ||
    data === null ||
    !("redirectUrl" in data) ||
    typeof data.redirectUrl !== "string"
  )
    throw new Error("Passkey verification failed. Your token was not changed.")
  const callback = new URL(data.redirectUrl, window.location.origin)
  if (
    callback.origin !== window.location.origin ||
    callback.pathname !== "/api/auth/callback"
  )
    throw new Error(
      "Unable to complete passkey verification. Please try again.",
    )
  if (!inPlace) {
    window.location.href = callback.href
    return
  }
  // Complete the redirect-based OAuth exchange in this document. Drafts and
  // pending intent stay in memory; reload never replays an action or a secret.
  const completed = await fetch(callback.href, {
    headers: { Accept: "application/json" },
    credentials: "include",
    ...(signal ? { signal } : {}),
    redirect: "error",
    cache: "no-store",
  })
  const result: unknown = await completed.json()
  if (
    typeof result === "object" &&
    result !== null &&
    "error" in result &&
    result.error === "environment_unavailable"
  )
    throw new Error(environmentUnavailableMessage)
  if (
    !completed.ok ||
    typeof result !== "object" ||
    result === null ||
    !("success" in result) ||
    result.success !== true
  )
    throw new Error(
      "Verification failed. Use the same account's passkey and try again. Your token was not changed.",
    )
}
