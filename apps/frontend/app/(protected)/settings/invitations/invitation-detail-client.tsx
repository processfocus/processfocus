"use client"
import { useQuery } from "@tanstack/react-query"
import { Schema } from "effect"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { QRCodeSVG } from "qrcode.react"
import { useEffect, useRef, useState } from "react"
import { EffectSchemaForm } from "@pf/form/effect-schema-form"
import { Button } from "@pf/shadcn-components"
import { DateTimeDisplay } from "@pf/shadcn-components/date-time-display"
import { InvitationDetailSkeleton } from "./invitation-detail-skeleton"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import type { LoginAuthProviders } from "@/lib/auth/providers"
import { invitationForm } from "@/lib/forms/invitation"
import { useGraphqlClient } from "@/lib/graphql/client-provider"
import {
  createInvitation,
  deleteInvitation,
  fetchAllInvitationRoles,
  fetchInvitationDetail,
  generateRegistrationLink,
  revealRegistrationLink,
  revokeRegistrationLink,
  rotateRegistrationLink,
  updateInvitation,
} from "@/lib/graphql/settings-queries"

interface InvitationDetailClientProps {
  invitationId?: string
  invitationMethods?: LoginAuthProviders["invitationMethods"]
}

export function InvitationDetailClient(props: InvitationDetailClientProps) {
  return <InvitationEditor key={props.invitationId ?? "new"} {...props} />
}

function InvitationEditor({
  invitationId,
  invitationMethods,
}: InvitationDetailClientProps) {
  const router = useRouter()
  const client = useGraphqlClient()
  const [formReady, setFormReady] = useState(false)
  const operationBusy = useRef(false)
  const visibilityGeneration = useRef(0)
  const [deleting, setDeleting] = useState(false)
  const [linkBusy, setLinkBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [revealedLink, setRevealedLink] = useState<string | null>(null)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)

  useEffect(() => {
    // Next.js can retain route state in Activity; hiding the page must discard
    // the revealed bearer URL as well as its QR code.
    return () => {
      visibilityGeneration.current++
      setRevealedLink(null)
    }
  }, [])

  const {
    data: invitationDetail,
    isLoading: invitationLoading,
    error: invitationError,
    refetch: refetchInvitation,
  } = useQuery({
    queryKey: ["settings", "invitation", invitationId],
    queryFn: () => fetchInvitationDetail(client, invitationId ?? ""),
    enabled: invitationId !== undefined,
  })

  const {
    data: loadedRoles,
    isLoading: rolesLoading,
    error: rolesError,
    refetch: refetchRoles,
  } = useQuery({
    queryKey: ["settings", "invitation-roles"],
    queryFn: () => fetchAllInvitationRoles(client),
  })

  const roles = loadedRoles ?? []

  useEffect(() => {
    let active = true
    setFormReady(false)
    setDeleteDialogOpen(false)
    setError(null)
    void Promise.all([
      refetchRoles(),
      ...(invitationId === undefined ? [] : [refetchInvitation()]),
    ]).then(() => {
      if (active) setFormReady(true)
    })
    return () => {
      active = false
    }
  }, [invitationId, refetchInvitation, refetchRoles])

  const loading =
    !formReady ||
    rolesLoading ||
    (invitationId !== undefined && invitationLoading)
  const queryError = invitationError || rolesError
  const isImmutable =
    invitationDetail?.status === "ACCEPTED" ||
    invitationDetail?.status === "LEGACY_CLOSED"
  const isReadOnly = isImmutable

  const title = invitationId
    ? isImmutable
      ? "Invitation History"
      : "Invitation Details"
    : "New Invitation"
  const description = invitationId
    ? isImmutable
      ? "Accepted and legacy-closed invitations are immutable history."
      : "Review and update the invitation before the user signs in."
    : "Create an invitation and assign the roles it should grant."

  const schema = invitationForm(
    roles.map((role) => ({
      value: role.id,
      label: role.name,
      description: role.path,
    })),
    isReadOnly,
  )

  const handleSave = async (values: Record<string, unknown>) => {
    if (isReadOnly || operationBusy.current) {
      return [
        {
          field: "",
          message: "Wait for the current action to finish before saving.",
        },
      ]
    }
    operationBusy.current = true
    setError(null)
    try {
      const submitted = Schema.decodeUnknownSync(
        Schema.Struct({
          ...schema.fields.invitation.fields,
          ...schema.fields.assignments.fields,
        }),
      )(values)
      const result = invitationId
        ? await updateInvitation(client, invitationId, submitted.email, [
            ...submitted.roleIds,
          ])
        : await createInvitation(client, submitted.email, [
            ...submitted.roleIds,
          ])
      if (result.__typename === "SaveInvitationFailure") {
        return [{ field: "", message: result.error }]
      } else {
        router.push("/settings/invitations")
        router.refresh()
        return undefined
      }
    } catch (saveError) {
      let message = "Failed to save invitation"
      if (saveError instanceof Error) {
        message = saveError.message
      }
      return [{ field: "", message }]
    } finally {
      operationBusy.current = false
    }
  }

  const handleDelete = async () => {
    if (!invitationId || isReadOnly || operationBusy.current) {
      return
    }

    operationBusy.current = true
    try {
      setDeleting(true)
      setError(null)

      const result = await deleteInvitation(client, invitationId)
      if (!result.success) {
        let message = "Failed to delete invitation"
        if (typeof result.error === "string") {
          message = result.error
        }
        setError(message)
      } else {
        setDeleteDialogOpen(false)
        router.push("/settings/invitations")
        router.refresh()
      }
    } catch (deleteError) {
      let message = "Failed to delete invitation"
      if (deleteError instanceof Error) {
        message = deleteError.message
      }
      setError(message)
    }
    setDeleting(false)
    operationBusy.current = false
  }

  const registrationLinkStatusLabel = (
    status: string | null | undefined,
  ): string => {
    if (status === "ACTIVE") return "Active"
    if (status === "EXPIRED") return "Expired"
    if (status === "REVOKED") return "Revoked"
    return "Not generated"
  }

  const copyLinkToClipboard = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url)
    } catch {
      // Clipboard may be unavailable; still surface the revealed URL.
    }
  }

  const handleRegistrationLinkAction = async (
    action: "generate" | "reveal" | "rotate" | "revoke",
  ) => {
    if (!invitationId || isReadOnly || operationBusy.current) {
      return
    }

    operationBusy.current = true
    setLinkBusy(true)
    const generation = visibilityGeneration.current
    setError(null)

    try {
      if (action === "revoke") {
        const result = await revokeRegistrationLink(client, invitationId)
        if (result.__typename === "SaveInvitationFailure") {
          setError(result.error)
        } else {
          setRevealedLink(null)
          await refetchInvitation()
        }
        return
      }

      const run =
        action === "generate"
          ? generateRegistrationLink
          : action === "reveal"
            ? revealRegistrationLink
            : rotateRegistrationLink
      const result = await run(client, invitationId)
      if (result.__typename === "RegistrationLinkActionFailure") {
        setError(result.error)
      } else {
        if (generation === visibilityGeneration.current) {
          setRevealedLink(result.registrationLinkUrl)
          await copyLinkToClipboard(result.registrationLinkUrl)
        }
        await refetchInvitation()
      }
    } catch (linkError) {
      let message = "Registration link action failed"
      if (linkError instanceof Error) {
        message = linkError.message
      }
      setError(message)
    } finally {
      setLinkBusy(false)
      operationBusy.current = false
    }
  }

  if (loading) {
    return <InvitationDetailSkeleton />
  }

  const queryErrorBanner = queryError ? (
    <div
      role="alert"
      className="rounded-md border border-red-200 bg-red-50 p-4 text-red-700"
    >
      <p className="font-medium">Error</p>
      <p className="text-sm">
        {queryError instanceof Error
          ? queryError.message
          : "Failed to load invitation data"}
      </p>
    </div>
  ) : null

  if (
    queryError &&
    ((invitationDetail === undefined && invitationId !== undefined) ||
      loadedRoles === undefined)
  ) {
    return queryErrorBanner
  }

  if (invitationId && !invitationDetail) {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 p-4 text-red-700">
        <p className="font-medium">Invitation not found</p>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">{title}</h1>
          <p className="mt-2 text-slate-600 dark:text-slate-400">
            {description}
          </p>
        </div>

        <Button asChild variant="outline">
          <Link href="/settings/invitations">Back to Invited Users</Link>
        </Button>
      </div>

      {!invitationId ? (
        <div className="space-y-2 text-sm text-slate-600 dark:text-slate-400">
          <p>
            <strong>Invitations are not sent automatically.</strong>
            {invitationMethods?.sso || invitationMethods?.passkey
              ? " After creating the invitation:"
              : null}
          </p>
          {invitationMethods?.sso || invitationMethods?.passkey ? (
            <ul className="list-disc space-y-1 pl-5">
              {invitationMethods.sso ? (
                <li>
                  <strong>SSO:</strong> Ask the person to visit the login page
                  and sign in using the invited email address.
                </li>
              ) : null}
              {invitationMethods.passkey ? (
                <li>
                  <strong>Passkey:</strong> Generate a registration link and
                  send it to the person yourself.
                </li>
              ) : null}
            </ul>
          ) : null}
        </div>
      ) : null}

      {queryErrorBanner}

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-red-700">
          <p className="font-medium">Error</p>
          <p className="text-sm">{error}</p>
        </div>
      )}

      <fieldset disabled={deleting || linkBusy} className="space-y-6">
        <EffectSchemaForm
          schema={schema}
          defaultValues={{
            email: invitationDetail?.email ?? "",
            roleIds: [
              ...new Set(invitationDetail?.roles.map((role) => role.id) ?? []),
            ],
          }}
          onSubmit={handleSave}
        >
          {({ formState: { isSubmitting: saving } }) => (
            <>
              {invitationDetail ? (
                <div className="space-y-1 text-sm text-slate-600 dark:text-slate-400">
                  <p>
                    Status:{" "}
                    <span className="font-medium text-slate-900 dark:text-slate-100">
                      {invitationDetail.status === "PENDING"
                        ? "Pending"
                        : invitationDetail.status === "ACCEPTED"
                          ? "Accepted"
                          : "Legacy closed"}
                    </span>
                  </p>
                  {invitationDetail.status === "ACCEPTED" ? (
                    <p>
                      Accepted by{" "}
                      {[
                        invitationDetail.acceptedByProvider,
                        invitationDetail.acceptedBySubject,
                      ]
                        .filter(Boolean)
                        .join(" / ") || "unknown identity"}
                      {invitationDetail.acceptedAt && (
                        <>
                          {" "}
                          ·{" "}
                          <DateTimeDisplay
                            kind="timestamp"
                            value={invitationDetail.acceptedAt}
                          />
                        </>
                      )}
                    </p>
                  ) : null}
                  {invitationDetail.status === "LEGACY_CLOSED" ? (
                    <p>
                      Closed during migration
                      {invitationDetail.legacyClosureReason
                        ? ` (${invitationDetail.legacyClosureReason})`
                        : ""}
                      {invitationDetail.legacyClosedAt && (
                        <>
                          {" "}
                          ·{" "}
                          <DateTimeDisplay
                            kind="timestamp"
                            value={invitationDetail.legacyClosedAt}
                          />
                        </>
                      )}
                      . This does not claim that this invitation created the
                      user or assigned roles.
                    </p>
                  ) : null}
                </div>
              ) : null}
              {invitationDetail && invitationDetail.status === "PENDING" ? (
                <div className="space-y-4 rounded-lg border border-slate-200 bg-white p-6 dark:border-slate-700 dark:bg-slate-900">
                  <h2 className="text-lg font-semibold">Registration Link</h2>
                  <p className="text-sm text-slate-600 dark:text-slate-400">
                    Passkey Invitation registration requires a seven-day
                    Registration Link. The bulk list never includes the bearer
                    token; generate or reveal it explicitly when you need to
                    share it outside Process Focus.
                  </p>

                  <div className="space-y-1 text-sm text-slate-600 dark:text-slate-400">
                    <p>
                      Status:{" "}
                      <span className="font-medium text-slate-900 dark:text-slate-100">
                        {registrationLinkStatusLabel(
                          invitationDetail.registrationLinkStatus,
                        )}
                      </span>
                    </p>
                    {invitationDetail.registrationLinkExpiresAt ? (
                      <p>
                        Expires:{" "}
                        <DateTimeDisplay
                          kind="timestamp"
                          value={invitationDetail.registrationLinkExpiresAt}
                          initialMode="browser-local"
                        />
                      </p>
                    ) : null}
                    {invitationDetail.registrationLinkGeneratedAt ? (
                      <p>
                        Last generated
                        {invitationDetail.registrationLinkGeneratedBy
                          ? ` by ${invitationDetail.registrationLinkGeneratedBy}`
                          : ""}
                        {" · "}
                        <DateTimeDisplay
                          kind="timestamp"
                          value={invitationDetail.registrationLinkGeneratedAt}
                        />
                      </p>
                    ) : null}
                    {invitationDetail.registrationLinkRevealedAt ? (
                      <p>
                        Last revealed
                        {invitationDetail.registrationLinkRevealedBy
                          ? ` by ${invitationDetail.registrationLinkRevealedBy}`
                          : ""}
                        {" · "}
                        <DateTimeDisplay
                          kind="timestamp"
                          value={invitationDetail.registrationLinkRevealedAt}
                        />
                      </p>
                    ) : null}
                    {invitationDetail.registrationLinkRevokedAt ? (
                      <p>
                        Last revoked
                        {invitationDetail.registrationLinkRevokedBy
                          ? ` by ${invitationDetail.registrationLinkRevokedBy}`
                          : ""}
                        {" · "}
                        <DateTimeDisplay
                          kind="timestamp"
                          value={invitationDetail.registrationLinkRevokedAt}
                        />
                      </p>
                    ) : null}
                  </div>

                  {revealedLink ? (
                    <div className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-950">
                      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                        Registration link (copy now; it is not stored in this
                        page after you leave)
                      </p>
                      <code className="block break-all text-sm text-slate-900 dark:text-slate-100">
                        {revealedLink}
                      </code>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => copyLinkToClipboard(revealedLink)}
                      >
                        Copy to clipboard
                      </Button>
                      <figure className="space-y-2 pt-2">
                        <QRCodeSVG
                          value={revealedLink}
                          size={256}
                          level="M"
                          marginSize={4}
                          bgColor="#ffffff"
                          fgColor="#000000"
                          role="img"
                          title="Registration link QR code"
                          aria-label="Registration link QR code"
                          className="h-auto max-w-full"
                        />
                        <figcaption className="text-sm text-slate-600 dark:text-slate-400">
                          Scan to register on your phone.
                        </figcaption>
                      </figure>
                    </div>
                  ) : null}

                  <div className="flex flex-wrap gap-2">
                    {invitationDetail.registrationLinkStatus ===
                      "NOT_GENERATED" ||
                    invitationDetail.registrationLinkStatus === "EXPIRED" ||
                    invitationDetail.registrationLinkStatus === "REVOKED" ? (
                      <Button
                        type="button"
                        onClick={() => handleRegistrationLinkAction("generate")}
                        disabled={saving || deleting || linkBusy}
                      >
                        {invitationDetail.registrationLinkStatus ===
                        "NOT_GENERATED"
                          ? "Generate registration link"
                          : "Generate new registration link"}
                      </Button>
                    ) : null}
                    {invitationDetail.registrationLinkStatus === "ACTIVE" ? (
                      <>
                        <Button
                          type="button"
                          onClick={() => handleRegistrationLinkAction("reveal")}
                          disabled={saving || deleting || linkBusy}
                        >
                          Copy / reveal link
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => handleRegistrationLinkAction("rotate")}
                          disabled={saving || deleting || linkBusy}
                        >
                          Rotate link
                        </Button>
                        <Button
                          type="button"
                          variant="destructive"
                          onClick={() => handleRegistrationLinkAction("revoke")}
                          disabled={saving || deleting || linkBusy}
                        >
                          Revoke link
                        </Button>
                      </>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {roles.length === 0 ? (
                <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-700">
                  No roles are available.
                </div>
              ) : null}

              <div className="flex flex-wrap items-center justify-between gap-3">
                {invitationId && !isReadOnly ? (
                  <Button
                    type="button"
                    variant="destructive"
                    onClick={() => setDeleteDialogOpen(true)}
                    disabled={saving || deleting || linkBusy}
                  >
                    Delete Invitation
                  </Button>
                ) : null}

                {!isReadOnly ? (
                  <Button
                    type="submit"
                    // The schema preserves the invitation email contract; the
                    // browser's email constraint accepts a narrower set.
                    formNoValidate
                    className="ml-auto"
                    disabled={
                      saving || deleting || linkBusy || roles.length === 0
                    }
                  >
                    {saving
                      ? "Saving..."
                      : invitationId
                        ? "Save"
                        : "Create Invitation"}
                  </Button>
                ) : (
                  <p className="ml-auto text-sm text-slate-500 dark:text-slate-400">
                    No bootstrap or edit actions are available for this
                    invitation.
                  </p>
                )}
              </div>

              <Dialog
                open={deleteDialogOpen}
                onOpenChange={setDeleteDialogOpen}
              >
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Delete Invitation</DialogTitle>
                    <DialogDescription>
                      This removes the invitation for{" "}
                      {invitationDetail?.email ?? "this user"}.
                    </DialogDescription>
                  </DialogHeader>

                  <DialogFooter>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setDeleteDialogOpen(false)}
                      disabled={saving || deleting || linkBusy}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      onClick={handleDelete}
                      disabled={saving || deleting || linkBusy}
                    >
                      {deleting ? "Deleting..." : "Delete Invitation"}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </>
          )}
        </EffectSchemaForm>
      </fieldset>
    </div>
  )
}
