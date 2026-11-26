"use client"

import { usePathname, useSearchParams } from "next/navigation"
import { useMemo, useState } from "react"
import { parseListReturnDestination } from "./list-refresh"
import { useReturnToList } from "./list-refresh-provider"
import StartProcessModalClient from "@/app/(protected)/processes/@modal/(.)start/[...startStepPath]/client"

const startPrefix = "/processes/start/"

/** The retained List reads its own URL state while the form owns the address bar. */
export function useListSearchParams() {
  const pathname = usePathname()
  const params = useSearchParams()
  return useMemo(() => {
    const destination = pathname.startsWith(startPrefix)
      ? parseListReturnDestination(params.get("returnTo"), "http://localhost")
      : null
    return destination
      ? new URL(destination.href, "http://localhost").searchParams
      : params
  }, [pathname, params])
}

/** Also mounted by the hard-navigation start page, using the same List server page. */
export function ListProcessDialog({ listPath }: { readonly listPath: string }) {
  const pathname = usePathname()
  const params = useSearchParams()
  const destination = parseListReturnDestination(
    params.get("returnTo"),
    "http://localhost",
  )
  if (!pathname.startsWith(startPrefix) || destination?.listPath !== listPath)
    return null
  return (
    <RetainedListProcessDialog
      key={pathname}
      startStepPath={`/${decodeURIComponent(pathname.slice(startPrefix.length))}`}
      sourceRecordId={params.get("sourceRecordId")}
    />
  )
}

function RetainedListProcessDialog({
  startStepPath,
  sourceRecordId,
}: {
  readonly startStepPath: string
  readonly sourceRecordId: string | null
}) {
  const returnToList = useReturnToList(true)
  const [initiator] = useState(() =>
    typeof document === "undefined" ? null : document.activeElement,
  )
  return (
    <StartProcessModalClient
      startStepPath={startStepPath}
      description={
        sourceRecordId
          ? `Start a process for List record ${sourceRecordId}`
          : "Start a process"
      }
      onClose={returnToList}
      onCloseAutoFocus={(event) => {
        event.preventDefault()
        if (initiator instanceof HTMLElement && initiator.isConnected) {
          initiator.focus()
        }
      }}
    />
  )
}
