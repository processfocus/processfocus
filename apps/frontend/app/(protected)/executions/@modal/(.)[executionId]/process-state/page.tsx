import { Suspense } from "react"
import { ProcessStateModalClient } from "../../../process-state-modal-client"

async function Content({
  params,
}: {
  params: Promise<{ executionId: string }>
}) {
  const { executionId } = await params

  return <ProcessStateModalClient executionId={executionId} />
}

export default function ExecutionProcessStateModalPage(props: {
  params: Promise<{ executionId: string }>
}) {
  return (
    <Suspense fallback={null}>
      <Content {...props} />
    </Suspense>
  )
}
