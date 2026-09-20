"use client"

import { useQuery } from "@tanstack/react-query"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useEffect, useState } from "react"
import { Button } from "@pf/shadcn-components"
import { InvitationDetailSkeleton } from "./invitation-detail-skeleton"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
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
}

const isValidEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)

export function InvitationDetailClient({
  invitationId,
}: InvitationDetailClientProps) {
  const router = useRouter()
  const client = useGraphqlClient()
  const [email, setEmail] = useState("")
  const [selectedRoleIds, setSelectedRoleIds] = useState<string[]>([])
  const [formInitialized, setFormInitialized] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [linkBusy, setLinkBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [revealedLink, setRevealedLink] = useState<string | null>(null)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)

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
    data: roles = [],
    isLoading: rolesLoading,
    error: rolesError,
  } = useQuery({
    queryKey: ["settings", "invitation-roles"],
    queryFn: () => fetchAllInvitationRoles(client),
  })

  useEffect(() => {
    if (!invitationDetail || formInitialized) {
      return
    }

    setEmail(invitationDetail.email)
    setSelectedRoleIds(invitationDetail.roles.map((role) => role.id))
    setFormInitialized(true)
  }, [formInitialized, invitationDetail])

  const loading =
    rolesLoading || (invitationId !== undefined && invitationLoading)
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

  const handleRoleToggle = (roleId: string) => {
    if (isReadOnly) {
      return
    }
    setSelectedRoleIds((current) =>
      current.includes(roleId)
        ? current.filter((id) => id !== roleId)
        : [...current, roleId],
    )
  }

  const handleSave = async () => {
    if (isReadOnly) {
      setError(
        "This invitation can no longer be changed. Create a new invitation if you need to grant roles again.",
      )
      return
    }

    const trimmedEmail = email.trim()
    if (!trimmedEmail) {
      setError("Email is required")
      return
    }

    if (!isValidEmail(trimmedEmail)) {
      setError("Enter a valid email address")
      return
    }

    if (selectedRoleIds.length === 0) {
      setError("Select at least one role")
      return
    }

    setSaving(true)
    setError(null)
    const saveInvitation = invitationId
      ? () =>
          updateInvitation(client, invitationId, trimmedEmail, selectedRoleIds)
      : () => createInvitation(client, trimmedEmail, selectedRoleIds)

    try {
      const result = await saveInvitation()
      if (result.__typename === "SaveInvitationFailure") {
        setError(result.error)
      } else {
        router.push("/settings")
        router.refresh()
      }
    } catch (saveError) {
      let message = "Failed to save invitation"
      if (saveError instanceof Error) {
        message = saveError.message
      }
      setError(message)
    }
    setSaving(false)
  }

  const handleDelete = async () => {
    if (!invitationId || isReadOnly) {
      return
    }

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
        router.push("/settings")
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
  }

  const formatWhen = (value: string | null | undefined) => {
    if (!value) {
      return null
    }
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) {
      return value
    }
    return date.toLocaleString()
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
    if (!invitationId || isReadOnly) {
      return
    }

    setLinkBusy(true)
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
        setRevealedLink(result.registrationLinkUrl)
        await copyLinkToClipboard(result.registrationLinkUrl)
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
    }
  }

  if (loading) {
    return <InvitationDetailSkeleton />
  }

  if (queryError) {
    const message =
      queryError instanceof Error
        ? queryError.message
        : "Failed to load invitation data"

    return (
      <div className="rounded-md border border-red-200 bg-red-50 p-4 text-red-700">
        <p className="font-medium">Error</p>
        <p className="text-sm">{message}</p>
      </div>
    )
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
          <Link href="/settings">Back to Settings</Link>
        </Button>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-red-700">
          <p className="font-medium">Error</p>
          <p className="text-sm">{error}</p>
        </div>
      )}

      <div className="space-y-4 rounded-lg border border-slate-200 bg-white p-6 dark:border-slate-700 dark:bg-slate-900">
        <h2 className="text-lg font-semibold">Invitation</h2>

        <div className="space-y-2">
          <label htmlFor="invitation-email" className="text-sm font-medium">
            Email
          </label>
          <Input
            id="invitation-email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="user@example.com"
            disabled={saving || deleting || isReadOnly}
            readOnly={isReadOnly}
          />
        </div>

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
                {formatWhen(invitationDetail.acceptedAt)
                  ? ` at ${formatWhen(invitationDetail.acceptedAt)}`
                  : ""}
              </p>
            ) : null}
            {invitationDetail.status === "LEGACY_CLOSED" ? (
              <p>
                Closed during migration
                {invitationDetail.legacyClosureReason
                  ? ` (${invitationDetail.legacyClosureReason})`
                  : ""}
                {formatWhen(invitationDetail.legacyClosedAt)
                  ? ` at ${formatWhen(invitationDetail.legacyClosedAt)}`
                  : ""}
                . This does not claim that this invitation created the user or
                assigned roles.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      {invitationDetail && invitationDetail.status === "PENDING" ? (
        <div className="space-y-4 rounded-lg border border-slate-200 bg-white p-6 dark:border-slate-700 dark:bg-slate-900">
          <h2 className="text-lg font-semibold">Registration Link</h2>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Passkey Invitation registration requires a seven-day Registration
            Link. The bulk list never includes the bearer token; generate or
            reveal it explicitly when you need to share it outside Process
            Focus.
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
                {formatWhen(invitationDetail.registrationLinkExpiresAt) ?? "—"}
              </p>
            ) : null}
            {invitationDetail.registrationLinkGeneratedAt ? (
              <p>
                Last generated
                {invitationDetail.registrationLinkGeneratedBy
                  ? ` by ${invitationDetail.registrationLinkGeneratedBy}`
                  : ""}
                {formatWhen(invitationDetail.registrationLinkGeneratedAt)
                  ? ` at ${formatWhen(invitationDetail.registrationLinkGeneratedAt)}`
                  : ""}
              </p>
            ) : null}
            {invitationDetail.registrationLinkRevealedAt ? (
              <p>
                Last revealed
                {invitationDetail.registrationLinkRevealedBy
                  ? ` by ${invitationDetail.registrationLinkRevealedBy}`
                  : ""}
                {formatWhen(invitationDetail.registrationLinkRevealedAt)
                  ? ` at ${formatWhen(invitationDetail.registrationLinkRevealedAt)}`
                  : ""}
              </p>
            ) : null}
            {invitationDetail.registrationLinkRevokedAt ? (
              <p>
                Last revoked
                {invitationDetail.registrationLinkRevokedBy
                  ? ` by ${invitationDetail.registrationLinkRevokedBy}`
                  : ""}
                {formatWhen(invitationDetail.registrationLinkRevokedAt)
                  ? ` at ${formatWhen(invitationDetail.registrationLinkRevokedAt)}`
                  : ""}
              </p>
            ) : null}
          </div>

          {revealedLink ? (
            <div className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-950">
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Registration link (copy now; it is not stored in this page after
                you leave)
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
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2">
            {invitationDetail.registrationLinkStatus === "NOT_GENERATED" ||
            invitationDetail.registrationLinkStatus === "EXPIRED" ||
            invitationDetail.registrationLinkStatus === "REVOKED" ? (
              <Button
                type="button"
                onClick={() => handleRegistrationLinkAction("generate")}
                disabled={saving || deleting || linkBusy}
              >
                {invitationDetail.registrationLinkStatus === "NOT_GENERATED"
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

      <div className="space-y-4 rounded-lg border border-slate-200 bg-white p-6 dark:border-slate-700 dark:bg-slate-900">
        <h2 className="text-lg font-semibold">Role Assignments</h2>

        {roles.length === 0 ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-700">
            No roles are available.
          </div>
        ) : (
          <div className="space-y-3">
            {roles.map((role) => (
              <div key={role.id} className="flex items-center gap-3">
                <Checkbox
                  id={`role-${role.id}`}
                  checked={selectedRoleIds.includes(role.id)}
                  onCheckedChange={() => handleRoleToggle(role.id)}
                  disabled={saving || deleting || isReadOnly}
                />
                <label
                  htmlFor={`role-${role.id}`}
                  className="flex cursor-pointer flex-col"
                >
                  <span className="font-medium">{role.name}</span>
                  <span className="text-sm text-slate-500 dark:text-slate-400">
                    {role.path}
                  </span>
                </label>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        {invitationId && !isReadOnly ? (
          <Button
            type="button"
            variant="destructive"
            onClick={() => setDeleteDialogOpen(true)}
            disabled={saving || deleting}
          >
            Delete Invitation
          </Button>
        ) : null}

        {!isReadOnly ? (
          <Button
            type="button"
            className="ml-auto"
            onClick={handleSave}
            disabled={saving || deleting || roles.length === 0}
          >
            {saving ? "Saving..." : invitationId ? "Save" : "Create Invitation"}
          </Button>
        ) : (
          <p className="ml-auto text-sm text-slate-500 dark:text-slate-400">
            No bootstrap or edit actions are available for this invitation.
          </p>
        )}
      </div>

      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Invitation</DialogTitle>
            <DialogDescription>
              This removes the invitation for{" "}
              {invitationDetail?.email ?? (email || "this user")}.
            </DialogDescription>
          </DialogHeader>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDeleteDialogOpen(false)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting ? "Deleting..." : "Delete Invitation"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
