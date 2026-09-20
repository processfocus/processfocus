"use client"

import { Copy } from "lucide-react"
import type { MouseEvent } from "react"
import { cn } from "@/lib/utils"

interface CopyButtonProps {
  value: string
  label: string
  className?: string
  iconClassName?: string
}

export function CopyButton({
  value,
  label,
  className,
  iconClassName,
}: CopyButtonProps) {
  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    void navigator.clipboard.writeText(value)
  }

  return (
    <button
      type="button"
      className={cn(
        "shrink-0 rounded-sm p-1 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200",
        className,
      )}
      aria-label={label}
      title={label}
      onClick={handleClick}
    >
      <Copy className={cn("h-4 w-4", iconClassName)} />
    </button>
  )
}
