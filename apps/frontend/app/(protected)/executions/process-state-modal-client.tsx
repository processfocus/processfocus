"use client"

import { useRouter, useSearchParams } from "next/navigation"
import { useCallback } from "react"
import { ProcessStateDialog } from "./process-state-dialog"

interface ProcessStateModalClientProps {
  executionId: string
}

export function ProcessStateModalClient({
  executionId,
}: ProcessStateModalClientProps) {
  const router = useRouter()
  const searchParams = useSearchParams()

  const handleClose = useCallback(() => {
    if (searchParams.get("from") === "executions") {
      router.back()
      return
    }

    router.replace("/executions", { scroll: false })
  }, [router, searchParams])

  return (
    <ProcessStateDialog
      executionId={executionId}
      open={true}
      onOpenChange={(open) => !open && handleClose()}
    />
  )
}
