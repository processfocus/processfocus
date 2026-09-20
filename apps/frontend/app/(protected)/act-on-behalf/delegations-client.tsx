"use client"

import { useEffect, useRef, useState, useTransition } from "react"
import { Button } from "@pf/shadcn-components"
import { createDelegation, listDelegations, updateDelegation } from "./actions"
import type { DelegationList, DelegationMetadata } from "@/lib/auth/delegations"
import { authenticateWithPasskey } from "@/lib/auth/verify-passkey"

function TokenTime({ value }: { value: string }) {
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

function SecretLifetime({
  replacement = false,
  disabled,
  issuanceDeadline,
  now,
}: {
  replacement?: boolean
  disabled: boolean
  issuanceDeadline: string | null
  now: number
}) {
  const [days, setDays] = useState(1)
  const selectedDeadline = now + days * 86_400_000
  const ancestorDeadline =
    issuanceDeadline === null ? Infinity : Date.parse(issuanceDeadline)
  const expiresAt = new Date(
    Math.min(selectedDeadline, ancestorDeadline),
  ).toISOString()
  return (
    <fieldset disabled={disabled} className="space-y-2">
      <legend className="text-sm font-medium">
        {replacement ? "New secret lifetime" : "Secret lifetime"}
      </legend>
      <div className="flex flex-wrap gap-3">
        {[1, 7, 14].map((duration) => (
          <label
            key={duration}
            className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md border px-4 py-2 text-sm"
          >
            <input
              type="radio"
              name="lifetimeDays"
              value={duration}
              checked={days === duration}
              onChange={() => setDays(duration)}
            />
            {duration} {duration === 1 ? "day" : "days"}
          </label>
        ))}
      </div>
      <p className="text-sm text-muted-foreground" aria-live="polite">
        Estimated expiry: <TokenTime value={expiresAt} />. Confirmed when
        created.
        {issuanceDeadline !== null && (
          <>
            {" "}
            Limited by your current access, ending{" "}
            <TokenTime value={issuanceDeadline} />.
            {ancestorDeadline <= now &&
              " Your access deadline has passed. Reload to check your access."}
          </>
        )}
      </p>
    </fieldset>
  )
}

export function DelegationsClient({
  initialDelegations,
  owner,
  ownerUserId,
  initialCanIssue,
  initialIssuanceDeadline,
  initialNow,
}: {
  initialDelegations: readonly DelegationMetadata[]
  owner: typeof DelegationList.Type.owner
  ownerUserId?: string | undefined
  initialCanIssue: boolean
  initialIssuanceDeadline: typeof DelegationList.Type.issuanceDeadline
  initialNow: number
}) {
  const [delegations, setDelegations] = useState(initialDelegations)
  const [canIssue, setCanIssue] = useState(initialCanIssue)
  const [issuanceDeadline, setIssuanceDeadline] = useState(
    initialIssuanceDeadline,
  )
  const [now, setNow] = useState(initialNow)
  const [denied, setDenied] = useState(false)
  const reauthenticationPath =
    ownerUserId === undefined
      ? "/act-on-behalf"
      : `/settings/users/${encodeURIComponent(ownerUserId)}/tokens`
  const [secret, setSecret] = useState<{
    value: string
    expiresAt: string
  } | null>(null)
  const [message, setMessage] = useState("")
  const [editing, setEditing] = useState<{
    operation: "rename" | "replace" | "revoke"
    token: DelegationMetadata
  } | null>(null)
  const [reloadRequired, setReloadRequired] = useState(false)
  const [pending, startTransition] = useTransition()
  const lifecycleGeneration = useRef(0)
  const issuanceVersion = useRef(0)
  const mutating = useRef(false)
  const createDetails = useRef<HTMLDetailsElement>(null)
  const secretHeading = useRef<HTMLHeadingElement>(null)
  const disclosedGeneration = useRef<{
    id: string
    generationId: string
  } | null>(null)

  const createRequestId = useRef<string | null>(null)
  const verification = useRef<AbortController | null>(null)
  const [verifying, setVerifying] = useState(false)

  async function withVerification<
    T extends { kind: "success" | "error" | "denied" },
  >(
    action: () => Promise<T | { kind: "verification_required" }>,
    operation: "create" | "replace",
    generation: number,
  ): Promise<T | { kind: "error"; message: string; reloadRequired: false }> {
    let result = await action()
    if (
      result.kind === "verification_required" &&
      generation === lifecycleGeneration.current
    ) {
      setMessage(
        `Verify with your passkey to ${operation === "create" ? "create this token" : "regenerate this secret"}.`,
      )
      const controller = new AbortController()
      verification.current = controller
      setVerifying(true)
      try {
        await authenticateWithPasskey({
          redirect: reauthenticationPath,
          purpose: "reauthenticate",
          inPlace: true,
          signal: controller.signal,
        })
      } catch (error) {
        return {
          kind: "error",
          reloadRequired: false,
          message:
            controller.signal.aborted ||
            (error instanceof Error && error.name === "NotAllowedError")
              ? "Verification was cancelled. Your input is saved here; no token was changed."
              : "Verification failed. Use the same account's passkey and try again. Your input is saved here; no token was changed.",
        }
      } finally {
        verification.current = null
        setVerifying(false)
      }
      if (
        controller.signal.aborted ||
        generation !== lifecycleGeneration.current
      )
        return {
          kind: "error",
          reloadRequired: false,
          message: "The pending action was cancelled.",
        }
      result = await action()
    }
    if (result.kind === "verification_required")
      return {
        kind: "error",
        reloadRequired: false,
        message:
          "Verification is no longer fresh enough. Your token was not changed. Submit again to retry.",
      }
    return result
  }

  function denyAccess(message: string) {
    verification.current?.abort()
    lifecycleGeneration.current += 1
    disclosedGeneration.current = null
    setSecret(null)
    setEditing(null)
    setDelegations([])
    setCanIssue(false)
    setDenied(true)
    setReloadRequired(false)
    setMessage(message)
  }

  useEffect(() => {
    if (secret !== null) secretHeading.current?.focus()
  }, [secret])

  useEffect(() => {
    let disposed = false
    let refreshing = false
    const timer = window.setInterval(async () => {
      if (refreshing) return
      refreshing = true
      const version = issuanceVersion.current
      const generation = lifecycleGeneration.current
      try {
        const result = await listDelegations(ownerUserId)
        if (
          disposed ||
          generation !== lifecycleGeneration.current ||
          result.kind === "error"
        )
          return
        if (result.kind === "denied") {
          clearSecret()
          setDenied(true)
          setCanIssue(false)
          setDelegations([])
          setMessage(result.message)
          return
        }
        setDenied(false)
        setCanIssue(result.canIssue)
        setIssuanceDeadline(result.issuanceDeadline)
        setNow(Date.now())
        // A snapshot overlapping a local mutation must not undo its result.
        if (version !== issuanceVersion.current || mutating.current) return
        const disclosed = disclosedGeneration.current
        if (
          disclosed &&
          !result.delegations.some(
            (token) =>
              token.id === disclosed.id &&
              token.generationId === disclosed.generationId &&
              token.status !== "revoked",
          )
        )
          clearSecret()
        setDelegations(result.delegations)
        setEditing((current) =>
          current &&
          result.delegations.some(
            (token) =>
              token.id === current.token.id &&
              token.allowedActions[current.operation],
          )
            ? current
            : null,
        )
      } catch {
        // Retain the last server status when the refresh cannot reach Next.js.
      } finally {
        refreshing = false
      }
    }, 30_000)
    const clearSecret = () => {
      verification.current?.abort()
      // Activity retains state while hidden; invalidate pending mutations too.
      lifecycleGeneration.current += 1
      disclosedGeneration.current = null
      setSecret(null)
      setEditing(null)
    }
    window.addEventListener("pagehide", clearSecret)
    return () => {
      disposed = true
      window.clearInterval(timer)
      window.removeEventListener("pagehide", clearSecret)
      clearSecret()
    }
  }, [ownerUserId])

  return (
    <div className="space-y-6">
      {!denied && ownerUserId !== undefined && (
        <p className="break-all text-sm">Tokens for {owner.email}</p>
      )}
      {!denied && (ownerUserId === undefined || canIssue) && (
        <details
          ref={createDetails}
          className="rounded-lg border bg-card p-4 sm:p-6"
        >
          <summary className="min-h-11 cursor-pointer content-center font-medium focus-visible:outline-2 focus-visible:outline-offset-4">
            Create token
          </summary>
          {canIssue ? (
            <form
              aria-label="Create token"
              className="mt-4 space-y-4"
              onSubmit={(event) => {
                event.preventDefault()
                if (
                  !canIssue ||
                  mutating.current ||
                  pending ||
                  secret !== null ||
                  reloadRequired
                )
                  return
                const data = new FormData(event.currentTarget)
                const issuanceGeneration = lifecycleGeneration.current
                issuanceVersion.current += 1
                mutating.current = true
                setSecret(null)
                setMessage("")
                startTransition(async () => {
                  let result: Exclude<
                    Awaited<ReturnType<typeof createDelegation>>,
                    { kind: "verification_required" }
                  >
                  try {
                    createRequestId.current ??= crypto.randomUUID()
                    const input = {
                      requestId: createRequestId.current,
                      name: data.get("name"),
                      lifetimeDays: Number(data.get("lifetimeDays")),
                    }
                    result = await withVerification(
                      () => createDelegation(input, owner.userId),
                      "create",
                      issuanceGeneration,
                    )
                  } catch {
                    if (issuanceGeneration !== lifecycleGeneration.current)
                      return
                    setMessage(
                      "Unable to reach the server. Reload your token list before retrying.",
                    )
                    return
                  } finally {
                    mutating.current = false
                    issuanceVersion.current += 1
                  }
                  if (issuanceGeneration !== lifecycleGeneration.current) return
                  if (result.kind === "denied") {
                    denyAccess(result.message)
                    return
                  }
                  if (result.kind === "error") {
                    setMessage(result.message)
                    return
                  }
                  setMessage("Token created.")
                  createRequestId.current = null
                  const { secret: issuedSecret, ...metadata } = result.data
                  setDelegations((previous) => [
                    metadata,
                    ...previous.filter((token) => token.id !== metadata.id),
                  ])
                  setSecret({
                    value: issuedSecret,
                    expiresAt: metadata.expiresAt,
                  })
                  setEditing(null)
                  if (createDetails.current) createDetails.current.open = false
                  disclosedGeneration.current = metadata
                })
              }}
            >
              <div className="space-y-2">
                <label
                  htmlFor="delegation-name"
                  className="text-sm font-medium"
                >
                  Name
                </label>
                <input
                  id="delegation-name"
                  name="name"
                  required
                  disabled={pending}
                  placeholder="invoice-agent"
                  className="min-h-11 w-full rounded-md border bg-background px-3 py-2 text-sm"
                />
              </div>
              <SecretLifetime
                disabled={pending}
                issuanceDeadline={issuanceDeadline}
                now={now}
              />
              <p className="text-sm text-muted-foreground">
                Anyone with this token can act on your behalf. Keep it private.
              </p>
              <Button
                type="submit"
                disabled={pending || secret !== null || reloadRequired}
              >
                {pending ? "Creating..." : "Create secret"}
              </Button>
            </form>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">
              Token creation is not currently permitted for this session.
            </p>
          )}
        </details>
      )}
      {secret !== null && (
        <section
          className="space-y-3 rounded-lg border bg-card p-4 sm:p-6 ph-no-capture ph-mask"
          data-ph-no-capture
          data-rrweb-mask
          aria-labelledby="secret-heading"
        >
          <h2
            id="secret-heading"
            ref={secretHeading}
            tabIndex={-1}
            className="font-semibold"
          >
            Copy your secret now
          </h2>
          <p className="text-sm text-muted-foreground">
            This is the only time it will be shown. Keep it somewhere safe.
            Leaving this page or dismissing it removes it from view.
          </p>
          <code
            className="block break-all rounded-md bg-muted p-3 text-sm"
            data-private
          >
            {secret.value}
          </code>
          <p className="text-sm">
            Expires <TokenTime value={secret.expiresAt} />.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              onClick={async () => {
                const generation = lifecycleGeneration.current
                try {
                  await navigator.clipboard.writeText(secret.value)
                  if (generation !== lifecycleGeneration.current) return
                  setMessage("Secret copied.")
                } catch {
                  if (generation !== lifecycleGeneration.current) return
                  setMessage(
                    "Unable to copy. Select the secret and copy it manually.",
                  )
                }
              }}
            >
              Copy secret
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                lifecycleGeneration.current += 1
                disclosedGeneration.current = null
                setSecret(null)
                setMessage("")
              }}
            >
              I have saved it
            </Button>
          </div>
        </section>
      )}
      <p role="status" className="text-sm">
        {message}
      </p>
      {verifying && (
        <Button
          type="button"
          variant="outline"
          onClick={() => verification.current?.abort()}
        >
          Cancel verification
        </Button>
      )}
      <section className="space-y-3" aria-labelledby="tokens-heading">
        <h2 id="tokens-heading" className="text-lg font-semibold">
          {ownerUserId === undefined ? "Your tokens" : "Tokens"}
        </h2>
        <Button
          type="button"
          variant="outline"
          disabled={pending || secret !== null}
          onClick={() => window.location.reload()}
        >
          Reload token list
        </Button>
        {!denied && delegations.length === 0 && (
          <p className="text-sm text-muted-foreground">
            {ownerUserId === undefined
              ? "You have no tokens yet. Create one to get started."
              : "This user has no tokens."}
          </p>
        )}
        {delegations.map((token) => (
          <article
            key={token.id}
            data-token-id={token.id}
            data-generation-id={token.generationId}
            className="space-y-3 rounded-lg border bg-card p-4 sm:p-6"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="break-all font-medium">{token.name}</h3>
              <span className="rounded-full bg-muted px-3 py-1 text-xs">
                {
                  {
                    active: "Active",
                    expired: "Expired",
                    revoked: "Revoked",
                  }[token.status]
                }
              </span>
            </div>
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              {ownerUserId !== undefined && (
                <>
                  <div>
                    <dt className="text-muted-foreground">Delegation ID</dt>
                    <dd className="break-all font-mono text-xs">{token.id}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Secret Generation</dt>
                    <dd className="break-all font-mono text-xs">
                      {token.generationId}
                    </dd>
                  </div>
                </>
              )}
              <div>
                <dt className="text-muted-foreground">Created</dt>
                <dd>
                  <TokenTime value={token.createdAt} />
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Secret expires</dt>
                <dd>
                  <TokenTime value={token.expiresAt} />
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Last used</dt>
                <dd>
                  {token.lastUsedAt ? (
                    <TokenTime value={token.lastUsedAt} />
                  ) : (
                    "Never used"
                  )}
                </dd>
              </div>
            </dl>
            <div className="flex flex-wrap gap-2">
              {(["rename", "replace", "revoke"] as const).map((operation) =>
                token.allowedActions[operation] &&
                (operation !== "replace" || token.status !== "revoked") ? (
                  <Button
                    key={operation}
                    type="button"
                    variant="outline"
                    disabled={pending || secret !== null || reloadRequired}
                    aria-expanded={
                      editing?.token.id === token.id &&
                      editing.operation === operation
                    }
                    aria-controls={`manage-${token.id}`}
                    onClick={() => {
                      setMessage("")
                      setEditing({ operation, token })
                    }}
                  >
                    {
                      {
                        rename: "Rename",
                        replace: "Regenerate",
                        revoke: "Revoke",
                      }[operation]
                    }
                  </Button>
                ) : null,
              )}
            </div>
            {editing?.token.id === token.id && (
              <form
                key={`${editing.operation}-${editing.token.generationId}-${editing.token.name}`}
                id={`manage-${token.id}`}
                aria-label={`${editing.operation === "rename" ? "Rename" : editing.operation === "replace" ? "Regenerate secret for" : "Revoke"} ${editing.token.name}`}
                className="space-y-4 border-t pt-4"
                onSubmit={(event) => {
                  event.preventDefault()
                  if (
                    mutating.current ||
                    pending ||
                    secret !== null ||
                    reloadRequired
                  )
                    return
                  const data = new FormData(event.currentTarget)
                  const generation = lifecycleGeneration.current
                  const { operation, token: original } = editing
                  const guards = {
                    operation,
                    id: original.id,
                    generationId: original.generationId,
                    expectedName: original.name,
                  }
                  const input =
                    operation === "revoke"
                      ? guards
                      : operation === "rename"
                        ? { ...guards, name: data.get("name") }
                        : {
                            ...guards,
                            name: data.get("name"),
                            lifetimeDays: Number(data.get("lifetimeDays")),
                          }
                  mutating.current = true
                  issuanceVersion.current += 1
                  setMessage("")
                  startTransition(async () => {
                    try {
                      const result =
                        operation === "replace"
                          ? await withVerification(
                              () => updateDelegation(input, owner.userId),
                              "replace",
                              generation,
                            )
                          : await updateDelegation(input, ownerUserId)
                      if (result.kind === "verification_required") return
                      if (generation !== lifecycleGeneration.current) return
                      if (result.kind === "denied") {
                        denyAccess(result.message)
                        return
                      }
                      if (result.kind === "error") {
                        setMessage(result.message)
                        setReloadRequired(result.reloadRequired)
                        return
                      }
                      const { secret: issuedSecret, ...metadata } = {
                        ...result.data,
                        secret:
                          "secret" in result.data ? result.data.secret : null,
                      }
                      setDelegations((previous) =>
                        previous.map((row) =>
                          row.id === metadata.id ? metadata : row,
                        ),
                      )
                      setEditing(null)
                      if (issuedSecret !== null) {
                        disclosedGeneration.current = metadata
                        setSecret({
                          value: issuedSecret,
                          expiresAt: metadata.expiresAt,
                        })
                      }
                      setMessage(
                        operation === "rename"
                          ? "Token renamed. Its secret and deadline are unchanged."
                          : operation === "revoke"
                            ? "Token revoked. Existing access stops within one minute."
                            : "New secret generated. The previous secret can no longer be used to log in.",
                      )
                    } catch {
                      if (generation !== lifecycleGeneration.current) return
                      setReloadRequired(true)
                      setMessage(
                        "Unable to reach the server. Reload the token list before retrying.",
                      )
                    } finally {
                      mutating.current = false
                      issuanceVersion.current += 1
                    }
                  })
                }}
              >
                <p className="text-sm text-muted-foreground">
                  {editing.operation === "rename"
                    ? "Change the name without changing this token's identity, secret, or deadline."
                    : editing.operation === "replace"
                      ? "Generate a distinct secret for this same token. The previous secret stops working for new logins immediately; existing access stops within one minute. If this name has been reused, choose another name."
                      : "Revoke this token permanently? It cannot receive another secret. Existing access stops within one minute. Completed actions and already-accepted work are not cancelled."}
                </p>
                {editing.operation !== "revoke" && (
                  <div className="space-y-2">
                    <label
                      htmlFor={`name-${token.id}`}
                      className="text-sm font-medium"
                    >
                      Token name
                    </label>
                    <input
                      id={`name-${token.id}`}
                      name="name"
                      required
                      defaultValue={editing.token.name}
                      disabled={pending || reloadRequired}
                      className="min-h-11 w-full rounded-md border bg-background px-3 py-2 text-sm"
                    />
                  </div>
                )}
                {editing.operation === "replace" && (
                  <SecretLifetime
                    replacement
                    disabled={pending || reloadRequired}
                    issuanceDeadline={issuanceDeadline}
                    now={now}
                  />
                )}
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="submit"
                    variant={
                      editing.operation === "revoke" ? "destructive" : "default"
                    }
                    disabled={pending || reloadRequired}
                  >
                    {pending
                      ? "Saving..."
                      : editing.operation === "rename"
                        ? "Save name"
                        : editing.operation === "replace"
                          ? "Regenerate secret"
                          : "Confirm revocation"}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={pending}
                    onClick={() => {
                      setEditing(null)
                      if (!reloadRequired) setMessage("")
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            )}
          </article>
        ))}
      </section>
    </div>
  )
}
