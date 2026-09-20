"use client"

import { formatDistanceToNow } from "date-fns"
import {
  CollectionTableCard,
  type CollectionTableColumn,
} from "@/components/collections/collection-table-card"
import { Checkbox } from "@/components/ui/checkbox"
import type { AllUsersQuery } from "@/lib/generated/gql/graphql"

type UserPage = AllUsersQuery["allUsers"]
type User = UserPage["items"][number]

interface UsersTableProps {
  data: UserPage
  onPageChange: (page: number) => void
}

const columns: CollectionTableColumn<User>[] = [
  {
    key: "email",
    label: "Email",
    cellClassName: "text-slate-600 dark:text-slate-400",
    render: (user) => user.providerUserEmail || "-",
  },
  {
    key: "providerUser",
    label: "Provider User",
    render: (user) => (
      <div className="flex items-center gap-2">
        <Checkbox checked={user.isProviderUser} disabled />
        {user.providerUserName && (
          <span className="text-sm text-slate-500 dark:text-slate-400">
            {user.providerUserName}
          </span>
        )}
      </div>
    ),
  },
  {
    key: "provider",
    label: "Provider",
    cellClassName: "font-medium",
    render: (user) => user.provider,
  },
  {
    key: "sub",
    label: "Subject",
    cellClassName: "max-w-[200px] truncate text-slate-600 dark:text-slate-400",
    render: (user) => user.sub,
  },
  {
    key: "lastLoggedIn",
    label: "Last Login",
    cellClassName: "text-slate-500 dark:text-slate-400",
    render: (user) =>
      formatDistanceToNow(new Date(user.lastLoggedIn), {
        addSuffix: true,
      }),
  },
]

export function UsersTable({ data, onPageChange }: UsersTableProps) {
  "use memo"

  return (
    <CollectionTableCard
      columns={columns}
      items={data.items}
      page={data.page}
      totalCount={data.totalCount}
      limit={data.limit}
      hasNextPage={data.hasNextPage}
      onPageChange={onPageChange}
      getRowKey={(user) => user.id}
      getRowHref={(user) =>
        user.isProviderUser ? `/settings/users/${user.id}` : null
      }
      emptyMessage="No users found"
    />
  )
}
