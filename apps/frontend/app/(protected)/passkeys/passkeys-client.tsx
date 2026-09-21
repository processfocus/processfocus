"use client"

import { startRegistration } from "@simplewebauthn/browser"
import { useState, useTransition } from "react"
import { Button } from "@pf/shadcn-components"
import {
  listPasskeys,
  removePasskey,
  renamePasskey,
  startPasskeyEnrollment,
  verifyPasskeyEnrollment,
} from "./actions"
import { Input } from "@/components/ui/input"
import type { PasskeyCredential, PasskeyList } from "@/lib/auth/passkeys"

const unnamedLabel = "Unnamed passkey"
const alreadyRegisteredMessage =
  "This Passkey is already registered. Try a different authenticator."
const cancelledMessage = "Registration was cancelled. You can try again."
const lastCredentialMessage =
  "Add a replacement Passkey before removing this one."
const confirmationCopy =
  "This Passkey will no longer be able to sign in. Existing sessions remain signed in."

function displayName(name: string | null): string {
  const trimmed = name?.trim() ?? ""
  return trimmed === "" ? unnamedLabel : trimmed
}

function AddedOn({ value }: { value: string }) {
  return (
    <time dateTime={value}>
      {new Intl.DateTimeFormat("en", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
      }).format(new Date(value))}{" "}
      UTC
    </time>
  )
}

const isAlreadyRegisteredError = (error: unknown): boolean => {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED"
  ) {
    return true
  }
  return error instanceof Error && error.name === "InvalidStateError"
}

const isCancellationError = (error: unknown): boolean => {
  if (error instanceof Error && error.name === "NotAllowedError") return true
  if (
    error !== null &&
    typeof error === "object" &&
    "cause" in error &&
    error.cause instanceof Error &&
    error.cause.name === "NotAllowedError"
  ) {
    return true
  }
  return false
}

export function PasskeysClient({
  organisationName,
  account,
  initialCredentials,
}: {
  organisationName: string
  account: typeof PasskeyList.Type.account
  initialCredentials: readonly PasskeyCredential[]
}) {
  const [credentials, setCredentials] = useState(initialCredentials)
  const [message, setMessage] = useState("")
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const refresh = () => {
    startTransition(async () => {
      const result = await listPasskeys()
      if (result.kind !== "success") {
        setMessage(result.message)
        return
      }
      setCredentials(result.credentials)
      setConfirmingId(null)
      setMessage("")
    })
  }

  return (
    <div className="space-y-6" data-testid="passkeys-page">
      <p className="text-sm text-muted-foreground">
        These Passkeys belong to {account.email} in {organisationName}. They
        sign in to this organisation only.
      </p>
      <p role="status" className="text-sm">
        {message}
      </p>
      <section className="space-y-3" aria-labelledby="add-passkey-heading">
        <h2 id="add-passkey-heading" className="text-lg font-semibold">
          Add a Passkey
        </h2>
        <form
          data-testid="add-passkey-form"
          className="flex flex-col gap-2 sm:flex-row sm:items-end"
          onSubmit={(event) => {
            event.preventDefault()
            const form = event.currentTarget
            const name = String(new FormData(form).get("name") ?? "")
            startTransition(async () => {
              const started = await startPasskeyEnrollment({ name })
              if (started.kind !== "options") {
                setMessage(started.message)
                return
              }
              try {
                const attestation = await startRegistration({
                  optionsJSON: started.options,
                })
                const result = await verifyPasskeyEnrollment({
                  challengeId: started.challengeId,
                  response: attestation,
                })
                if (result.kind === "success") {
                  setCredentials(result.credentials)
                  setMessage("Passkey added.")
                  form.reset()
                  return
                }
                setMessage(result.message)
              } catch (error) {
                if (isAlreadyRegisteredError(error)) {
                  setMessage(alreadyRegisteredMessage)
                  return
                }
                if (isCancellationError(error)) {
                  setMessage(cancelledMessage)
                  return
                }
                setMessage(
                  error instanceof Error
                    ? error.message
                    : "Unable to add this Passkey.",
                )
              }
            })
          }}
        >
          <div className="min-w-0 flex-1 space-y-1 text-sm">
            <label htmlFor="add-passkey-name">Name</label>
            <Input
              id="add-passkey-name"
              name="name"
              disabled={pending}
              maxLength={128}
              required
              aria-label="Name for the new Passkey"
            />
          </div>
          <Button type="submit" disabled={pending}>
            {pending ? "Adding Passkey…" : "Add Passkey"}
          </Button>
        </form>
      </section>
      <section className="space-y-3" aria-labelledby="passkeys-heading">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="passkeys-heading" className="text-lg font-semibold">
            Your Passkeys
          </h2>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={refresh}
          >
            Reload
          </Button>
        </div>
        {credentials.map((credential) => (
          <article
            key={credential.id}
            data-passkey-id={credential.id}
            className="space-y-3 rounded-lg border bg-card p-4 sm:p-6"
          >
            <h3 className="font-medium" data-testid="passkey-name">
              {displayName(credential.name)}
            </h3>
            <p className="text-sm text-muted-foreground">
              Date added: <AddedOn value={credential.createdAt} />
            </p>
            <p
              className="text-sm text-muted-foreground"
              data-testid="passkey-last-used"
            >
              Last used:{" "}
              {credential.lastUsedAt ? (
                <AddedOn value={credential.lastUsedAt} />
              ) : (
                "Unknown"
              )}
            </p>
            <form
              key={credential.name ?? ""}
              className="flex flex-col gap-2 sm:flex-row sm:items-end"
              onSubmit={(event) => {
                event.preventDefault()
                const name = String(
                  new FormData(event.currentTarget).get("name") ?? "",
                )
                startTransition(async () => {
                  const result = await renamePasskey({
                    id: credential.id,
                    name,
                  })
                  if (result.kind !== "success") {
                    setMessage(result.message)
                    return
                  }
                  setCredentials(result.credentials)
                  setMessage("Passkey name saved.")
                })
              }}
            >
              <div className="min-w-0 flex-1 space-y-1 text-sm">
                <label htmlFor={`passkey-name-${credential.id}`}>Name</label>
                <Input
                  id={`passkey-name-${credential.id}`}
                  name="name"
                  defaultValue={credential.name?.trim() ?? ""}
                  disabled={pending}
                  maxLength={128}
                  aria-label={`Name for ${displayName(credential.name)}`}
                />
              </div>
              <Button type="submit" disabled={pending}>
                Save name
              </Button>
            </form>
            {confirmingId === credential.id ? (
              <form
                className="space-y-3 border-t pt-3"
                aria-label={`Remove ${displayName(credential.name)}`}
                onSubmit={(event) => {
                  event.preventDefault()
                  if (credentials.length < 2) {
                    setConfirmingId(null)
                    setMessage(lastCredentialMessage)
                    return
                  }
                  startTransition(async () => {
                    const result = await removePasskey({ id: credential.id })
                    if (result.kind !== "success") {
                      setMessage(result.message)
                      if (result.message === lastCredentialMessage) {
                        setConfirmingId(null)
                      }
                      return
                    }
                    setCredentials(result.credentials)
                    setConfirmingId(null)
                    setMessage("Passkey removed.")
                  })
                }}
              >
                <p className="text-sm text-muted-foreground">
                  {confirmationCopy}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="submit"
                    variant="destructive"
                    disabled={pending}
                    data-testid="passkey-confirm-remove"
                  >
                    Confirm removal
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={pending}
                    onClick={() => {
                      setConfirmingId(null)
                      setMessage("")
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            ) : (
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                data-testid="passkey-remove"
                aria-label={`Remove ${displayName(credential.name)}`}
                onClick={() => {
                  if (credentials.length < 2) {
                    setMessage(lastCredentialMessage)
                    return
                  }
                  setMessage("")
                  setConfirmingId(credential.id)
                }}
              >
                Remove
              </Button>
            )}
          </article>
        ))}
      </section>
    </div>
  )
}
