"use client"

import Link from "next/link"
import { Button } from "@pf/shadcn-components"
import {
  CollectionTableCard,
  type CollectionTableColumn,
} from "@/components/collections/collection-table-card"
import type {
  AllInvitationsQuery,
  InvitationLifecycleStatus,
} from "@/lib/generated/gql/graphql"

type InvitationPage = AllInvitationsQuery["allInvitations"]
type Invitation = InvitationPage["items"][number]

interface InvitationsTableProps {
  data: InvitationPage
  status: InvitationLifecycleStatus
  onPageChange: (page: number) => void
  onStatusChange: (status: InvitationLifecycleStatus) => void
}

const statusLabel: Record<InvitationLifecycleStatus, string> = {
  PENDING: "Pending",
  ACCEPTED: "Accepted",
  LEGACY_CLOSED: "Legacy closed",
}

const formatWhen = (value: string | null | undefined) => {
  if (!value) {
    return "—"
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  return date.toLocaleString()
}

const columns: CollectionTableColumn<Invitation>[] = [
  {
    key: "email",
    label: "Email",
    cellClassName: "font-medium",
    render: (invitation) => invitation.email,
  },
  {
    key: "roles",
    label: "Roles",
    cellClassName: "text-slate-600 dark:text-slate-400",
    render: (invitation) =>
      invitation.roles.map((role) => role.name).join(", ") || "—",
  },
  {
    key: "status",
    label: "Status",
    cellClassName: "text-slate-600 dark:text-slate-400",
    render: (invitation) => statusLabel[invitation.status],
  },
  {
    key: "registrationLink",
    label: "Registration link",
    cellClassName: "text-slate-600 dark:text-slate-400",
    render: (invitation) => {
      if (invitation.status !== "PENDING") {
        return "—"
      }
      const linkStatus = invitation.registrationLinkStatus
      if (linkStatus === "NOT_GENERATED") {
        return "Not generated"
      }
      if (linkStatus === "ACTIVE") {
        return `Active · expires ${formatWhen(invitation.registrationLinkExpiresAt)}`
      }
      if (linkStatus === "EXPIRED") {
        return `Expired · ${formatWhen(invitation.registrationLinkExpiresAt)}`
      }
      if (linkStatus === "REVOKED") {
        return `Revoked · ${formatWhen(invitation.registrationLinkRevokedAt)}`
      }
      return "—"
    },
  },
  {
    key: "acceptance",
    label: "Acceptance",
    cellClassName: "text-slate-600 dark:text-slate-400",
    render: (invitation) => {
      if (invitation.status === "ACCEPTED") {
        const identity = [
          invitation.acceptedByProvider,
          invitation.acceptedBySubject,
        ]
          .filter(Boolean)
          .join(" / ")
        const when = formatWhen(invitation.acceptedAt)
        if (!identity && when === "—") {
          return "Accepted"
        }
        return [identity || "Accepted", when !== "—" ? when : null]
          .filter(Boolean)
          .join(" · ")
      }
      if (invitation.status === "LEGACY_CLOSED") {
        return [
          invitation.legacyClosureReason ?? "Existing user at migration",
          formatWhen(invitation.legacyClosedAt),
        ]
          .filter((part) => part && part !== "—")
          .join(" · ")
      }
      return "—"
    },
  },
]

export function InvitationsTable({
  data,
  status,
  onPageChange,
  onStatusChange,
}: InvitationsTableProps) {
  "use memo"

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            Invited Users
          </h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Pending invitations are outstanding onboarding work. Accepted and
            legacy-closed rows are immutable history.
          </p>
        </div>

        {status === "PENDING" ? (
          <Button asChild>
            <Link href="/settings/invitations/new">New Invitation</Link>
          </Button>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-2">
        {(
          [
            "PENDING",
            "ACCEPTED",
            "LEGACY_CLOSED",
          ] as const satisfies readonly InvitationLifecycleStatus[]
        ).map((value) => (
          <Button
            key={value}
            type="button"
            size="sm"
            variant={status === value ? "default" : "outline"}
            onClick={() => onStatusChange(value)}
          >
            {statusLabel[value]}
          </Button>
        ))}
      </div>

      <CollectionTableCard
        columns={columns}
        items={data.items}
        page={data.page}
        totalCount={data.totalCount}
        limit={data.limit}
        hasNextPage={data.hasNextPage}
        onPageChange={onPageChange}
        getRowKey={(invitation) => invitation.id}
        getRowHref={(invitation) => `/settings/invitations/${invitation.id}`}
        emptyMessage={
          status === "PENDING"
            ? "No pending invitations"
            : status === "ACCEPTED"
              ? "No accepted invitations"
              : "No legacy-closed invitations"
        }
      />
    </div>
  )
}
