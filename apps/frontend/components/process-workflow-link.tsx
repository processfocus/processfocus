"use client"

import { Info } from "lucide-react"
import Link from "next/link"
import { useState } from "react"
import { toUrlPath } from "@/lib/utils"

export function ProcessWorkflowLink({
  processName,
  processPath,
}: {
  processName: string
  processPath: string | undefined
}) {
  const [prefetchOnIntent, setPrefetchOnIntent] = useState(false)
  const urlPath = processPath ? toUrlPath(processPath) : ""

  if (!urlPath) return null

  const accessibleName = `View workflow information for ${processName}`

  return (
    <Link
      href={`/processes/workflow/${urlPath}`}
      // The shared shell includes workflow assets; defer that cost until intent.
      prefetch={prefetchOnIntent ? null : false}
      onMouseEnter={() => setPrefetchOnIntent(true)}
      onFocus={() => setPrefetchOnIntent(true)}
      aria-label={accessibleName}
      title={accessibleName}
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-blue-500/10 text-blue-500 transition-colors hover:bg-blue-500/20 hover:text-blue-600 dark:bg-blue-400/10 dark:text-blue-200 dark:hover:bg-blue-400/20 dark:hover:text-white"
    >
      <Info aria-hidden="true" className="h-6 w-6" />
    </Link>
  )
}
