import Link from "next/link"
import { cn } from "@/lib/utils"

export type TabPillProps = {
  label: string
  count?: number
  active: boolean
} & ({ href: string } | { onClick: () => void })

export function TabPill(props: TabPillProps) {
  const { label, count, active } = props
  const className = cn(
    "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium transition",
    active
      ? "border-blue-500 bg-blue-500/10 text-blue-600 dark:border-blue-400 dark:bg-blue-500/10 dark:text-blue-200"
      : "border-slate-200 text-slate-600 hover:border-slate-300 hover:text-slate-800 dark:border-slate-700 dark:text-slate-300 dark:hover:border-slate-600",
  )
  const content = (
    <>
      {label}
      {count !== undefined ? (
        <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-semibold text-slate-600 dark:bg-slate-700 dark:text-slate-300">
          {count}
        </span>
      ) : null}
    </>
  )
  return "href" in props ? (
    <Link
      href={props.href}
      aria-current={active ? "page" : undefined}
      className={className}
    >
      {content}
    </Link>
  ) : (
    <button type="button" onClick={props.onClick} className={className}>
      {content}
    </button>
  )
}
