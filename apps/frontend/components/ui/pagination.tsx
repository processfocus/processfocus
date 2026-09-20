import { ChevronLeft, ChevronRight } from "lucide-react"
import { Button } from "@pf/shadcn-components"

export interface PaginationProps {
  page: number
  totalCount: number
  limit: number
  hasNextPage: boolean
  onPageChange: (page: number) => void
}

export function Pagination({
  page,
  totalCount,
  limit,
  hasNextPage,
  onPageChange,
}: PaginationProps) {
  const totalPages = Math.ceil(totalCount / limit)
  const hasPreviousPage = page > 1

  return (
    <div className="flex items-center justify-between px-2 py-4">
      <div className="text-sm text-slate-500 dark:text-slate-400">
        {totalCount > 0 ? (
          <>
            Showing {(page - 1) * limit + 1} -{" "}
            {Math.min(page * limit, totalCount)} of {totalCount}
          </>
        ) : (
          "No items"
        )}
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => onPageChange(page - 1)}
          disabled={!hasPreviousPage}
        >
          <ChevronLeft className="h-4 w-4" />
          Previous
        </Button>
        <span className="text-sm text-slate-600 dark:text-slate-300">
          Page {page} of {totalPages || 1}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onPageChange(page + 1)}
          disabled={!hasNextPage}
        >
          Next
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}
