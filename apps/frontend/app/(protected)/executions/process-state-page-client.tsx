"use client"

import { useRouter } from "next/navigation"
import { useCallback } from "react"
import { ExecutionsPageContent } from "./page"
import { ProcessStateDialog } from "./process-state-dialog"

interface ProcessStatePageClientProps {
  executionId: string
}

export function ProcessStatePageClient({
  executionId,
}: ProcessStatePageClientProps) {
  const router = useRouter()

  const handleClose = useCallback(() => {
    router.replace("/executions", { scroll: false })
  }, [router])

  return (
    <>
      <ExecutionsPageContent initialSelectedExecutionId={executionId} />
      <ProcessStateDialog
        executionId={executionId}
        open={true}
        onOpenChange={(open) => !open && handleClose()}
      />
    </>
  )
}
