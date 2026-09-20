import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react"
import type { ReactNode } from "react"
import { TableHead, TableRow } from "@/components/ui/table"
import { cn } from "@/lib/utils"

export interface CollectionTableColumn<TItem> {
  readonly key: string
  readonly label: ReactNode
  readonly render: (item: TItem, index: number) => ReactNode
  readonly sortable?: boolean
  readonly sortDirection?: "asc" | "desc" | null
  readonly headerClassName?: string
  readonly cellClassName?: string
}

function getAriaSort(direction: "asc" | "desc" | null | undefined) {
  if (direction === "asc") return "ascending"
  if (direction === "desc") return "descending"
  return "none"
}

function getSortStatus(direction: "asc" | "desc" | null | undefined) {
  if (direction === "asc")
    return "Sorted ascending. Activate to sort descending."
  if (direction === "desc")
    return "Sorted descending. Activate to use default list order."
  return "Not sorted. Activate to sort ascending."
}

function SortIcon({
  direction,
}: {
  readonly direction: "asc" | "desc" | null | undefined
}) {
  const className = cn(
    "h-4 w-4 shrink-0",
    direction ? "text-slate-900 dark:text-slate-100" : "text-slate-400",
  )

  if (direction === "asc") {
    return <ArrowUp aria-hidden="true" className={className} />
  }

  if (direction === "desc") {
    return <ArrowDown aria-hidden="true" className={className} />
  }

  return <ArrowUpDown aria-hidden="true" className={className} />
}

interface CollectionTableHeaderRowProps<TItem> {
  readonly columns: readonly CollectionTableColumn<TItem>[]
  readonly onSortChange?: ((columnKey: string) => void) | undefined
}

export function CollectionTableHeaderRow<TItem>({
  columns,
  onSortChange,
}: CollectionTableHeaderRowProps<TItem>) {
  return (
    <TableRow>
      {columns.map((column) => {
        const isSortable = column.sortable === true && !!onSortChange
        const sortDirection = column.sortDirection ?? null

        return (
          <TableHead
            key={column.key}
            className={column.headerClassName}
            aria-sort={isSortable ? getAriaSort(sortDirection) : undefined}
          >
            {isSortable ? (
              <button
                type="button"
                className={cn(
                  "flex h-8 w-full items-center justify-between gap-2 rounded px-0 text-left transition-colors hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2 dark:hover:text-slate-100 dark:focus-visible:ring-slate-500",
                  sortDirection
                    ? "text-slate-900 dark:text-slate-100"
                    : "text-slate-500 dark:text-slate-400",
                )}
                onClick={() => onSortChange(column.key)}
              >
                <span>{column.label}</span>
                <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                  <SortIcon direction={sortDirection} />
                </span>
                <span className="sr-only">{getSortStatus(sortDirection)}</span>
              </button>
            ) : (
              column.label
            )}
          </TableHead>
        )
      })}
    </TableRow>
  )
}
