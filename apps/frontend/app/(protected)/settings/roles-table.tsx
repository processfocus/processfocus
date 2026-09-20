"use client"

import {
  CollectionTableCard,
  type CollectionTableColumn,
} from "@/components/collections/collection-table-card"
import type { AllSettingsRolesQuery } from "@/lib/generated/gql/graphql"

type RolePage = AllSettingsRolesQuery["allRoles"]
type Role = RolePage["items"][number]

interface RolesTableProps {
  data: RolePage
  onPageChange: (page: number) => void
}

function orgUnitName(rolePath: string): string {
  // Path is like "/OrgUnit/RoleName" or "/Nested/OrgUnit/RoleName"
  // Extract the org unit portion (everything before the last segment)
  const segments = rolePath.split("/").filter(Boolean)
  if (segments.length <= 1) return "/"
  return segments.slice(0, -1).join("/")
}

const columns: CollectionTableColumn<Role>[] = [
  {
    key: "orgUnit",
    label: "Org Unit",
    cellClassName: "text-slate-600 dark:text-slate-400",
    render: (role) => orgUnitName(role.path),
  },
  {
    key: "name",
    label: "Role Name",
    cellClassName: "font-medium",
    render: (role) => role.name,
  },
  {
    key: "path",
    label: "Path",
    cellClassName: "font-mono text-sm text-slate-500 dark:text-slate-400",
    render: (role) => role.path,
  },
]

export function RolesTable({ data, onPageChange }: RolesTableProps) {
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
      getRowKey={(role) => role.id}
      emptyMessage="No roles found"
    />
  )
}
