"use client"

import { useRouter } from "next/navigation"
import type { KeyboardEvent, MouseEvent } from "react"
import {
  type CollectionTableColumn,
  CollectionTableHeaderRow,
} from "@/components/collections/collection-table-header-row"
import { Pagination } from "@/components/ui/pagination"
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { cn } from "@/lib/utils"

export type { CollectionTableColumn }

interface CollectionTableCardProps<TItem> {
  readonly columns: readonly CollectionTableColumn<TItem>[]
  readonly items: readonly TItem[]
  readonly page: number
  readonly totalCount: number
  readonly limit: number
  readonly hasNextPage: boolean
  readonly onPageChange: (page: number) => void
  readonly getRowKey: (item: TItem, index: number) => string
  readonly getRowHref?: (item: TItem, index: number) => string | null
  readonly getRowClassName?: (item: TItem, index: number) => string | undefined
  readonly onSortChange?: (columnKey: string) => void
  readonly emptyMessage: string
  readonly className?: string
}

function shouldIgnoreRowNavigation(target: EventTarget | null) {
  if (!(target instanceof Element)) {
    return false
  }

  const interactiveElement = target.closest(
    "a, button, input, select, textarea, [role='button'], [role='combobox'], [role='link'], [role='listbox'], [role='menuitem'], [role='option']",
  )

  if (!interactiveElement) {
    return false
  }

  if (
    interactiveElement instanceof HTMLButtonElement ||
    interactiveElement instanceof HTMLInputElement ||
    interactiveElement instanceof HTMLSelectElement ||
    interactiveElement instanceof HTMLTextAreaElement
  ) {
    return !interactiveElement.disabled
  }

  return (
    interactiveElement.getAttribute("aria-disabled") !== "true" &&
    !interactiveElement.hasAttribute("data-disabled")
  )
}

export function CollectionTableCard<TItem>({
  columns,
  items,
  page,
  totalCount,
  limit,
  hasNextPage,
  onPageChange,
  getRowKey,
  getRowHref,
  getRowClassName,
  onSortChange,
  emptyMessage,
  className,
}: CollectionTableCardProps<TItem>) {
  const router = useRouter()

  const navigateToRow = (rowHref: string) => {
    router.push(rowHref)
  }

  const openRowInNewTab = (rowHref: string) => {
    window.open(rowHref, "_blank", "noopener,noreferrer")
  }

  const prefetchRow = (rowHref: string | null) => {
    if (rowHref !== null) {
      router.prefetch(rowHref)
    }
  }

  const handleRowClick = (
    event: MouseEvent<HTMLTableRowElement>,
    rowHref: string | null,
  ) => {
    if (
      rowHref === null ||
      event.defaultPrevented ||
      shouldIgnoreRowNavigation(event.target)
    ) {
      return
    }

    if (event.button !== 0) {
      return
    }

    if (event.metaKey || event.ctrlKey) {
      openRowInNewTab(rowHref)
      return
    }

    navigateToRow(rowHref)
  }

  const handleRowAuxClick = (
    event: MouseEvent<HTMLTableRowElement>,
    rowHref: string | null,
  ) => {
    if (
      rowHref === null ||
      event.defaultPrevented ||
      shouldIgnoreRowNavigation(event.target)
    ) {
      return
    }

    if (event.button === 1) {
      openRowInNewTab(rowHref)
    }
  }

  const handleRowKeyDown = (
    event: KeyboardEvent<HTMLTableRowElement>,
    rowHref: string | null,
  ) => {
    if (
      rowHref === null ||
      event.defaultPrevented ||
      event.target !== event.currentTarget
    ) {
      return
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault()
      navigateToRow(rowHref)
    }
  }

  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900",
        className,
      )}
    >
      <Table>
        <TableHeader>
          <CollectionTableHeaderRow
            columns={columns}
            onSortChange={onSortChange}
          />
        </TableHeader>
        <TableBody>
          {items.map((item, index) => {
            const rowHref = getRowHref?.(item, index) ?? null
            const rowIsClickable = rowHref !== null

            return (
              <TableRow
                key={getRowKey(item, index)}
                className={cn(
                  rowIsClickable &&
                    "relative cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/80",
                  getRowClassName?.(item, index),
                )}
                onClick={(event) => handleRowClick(event, rowHref)}
                onAuxClick={(event) => handleRowAuxClick(event, rowHref)}
                onKeyDown={(event) => handleRowKeyDown(event, rowHref)}
                onFocus={() => prefetchRow(rowHref)}
                onMouseEnter={() => prefetchRow(rowHref)}
                tabIndex={rowIsClickable ? 0 : undefined}
              >
                {columns.map((column) => (
                  <TableCell key={column.key} className={column.cellClassName}>
                    {column.render(item, index)}
                  </TableCell>
                ))}
              </TableRow>
            )
          })}
          {items.length === 0 && (
            <TableRow>
              <TableCell
                colSpan={Math.max(columns.length, 1)}
                className="text-center text-slate-500 dark:text-slate-400"
              >
                {emptyMessage}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      <Pagination
        page={page}
        totalCount={totalCount}
        limit={limit}
        hasNextPage={hasNextPage}
        onPageChange={onPageChange}
      />
    </div>
  )
}
