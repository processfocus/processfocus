import { Suspense } from "react"
import { ProcessStatePageClient } from "../../process-state-page-client"
import { ProcessStateRouteFallback } from "../../process-state-route-fallback"

async function Content({
  params,
}: {
  params: Promise<{ executionId: string }>
}) {
  const { executionId } = await params

  return <ProcessStatePageClient executionId={executionId} />
}

export default function ExecutionProcessStatePage(props: {
  params: Promise<{ executionId: string }>
}) {
  return (
    <Suspense fallback={<ProcessStateRouteFallback />}>
      <Content {...props} />
    </Suspense>
  )
}
