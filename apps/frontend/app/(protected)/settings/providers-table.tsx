"use client"

import {
  CollectionTableCard,
  type CollectionTableColumn,
} from "@/components/collections/collection-table-card"
import type { AllOAuthProvidersQuery } from "@/lib/generated/gql/graphql"

type ProviderPage = AllOAuthProvidersQuery["allOAuthProviders"]
type Provider = ProviderPage["items"][number]

interface ProvidersTableProps {
  data: ProviderPage
  onPageChange: (page: number) => void
}

const columns: CollectionTableColumn<Provider>[] = [
  {
    key: "id",
    label: "ID",
    cellClassName: "font-mono text-sm text-slate-500 dark:text-slate-400",
    render: (provider) => provider.id,
  },
  {
    key: "providerName",
    label: "Provider Name",
    cellClassName: "font-medium",
    render: (provider) => provider.providerName,
  },
]

export function ProvidersTable({ data, onPageChange }: ProvidersTableProps) {
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
      getRowKey={(provider) => provider.id}
      emptyMessage="No OAuth providers found"
    />
  )
}
