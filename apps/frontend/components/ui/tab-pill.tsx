import { cn } from "@/lib/utils"

export interface TabPillProps {
  label: string
  count?: number
  active: boolean
  onClick: () => void
}

export function TabPill({ label, count, active, onClick }: TabPillProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium transition",
        active
          ? "border-blue-500 bg-blue-500/10 text-blue-600 dark:border-blue-400 dark:bg-blue-500/10 dark:text-blue-200"
          : "border-slate-200 text-slate-600 hover:border-slate-300 hover:text-slate-800 dark:border-slate-700 dark:text-slate-300 dark:hover:border-slate-600",
      )}
    >
      {label}
      {count !== undefined ? (
        <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-semibold text-slate-600 dark:bg-slate-700 dark:text-slate-300">
          {count}
        </span>
      ) : null}
    </button>
  )
}
