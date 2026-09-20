import { Suspense } from "react"
import ExecutionDetailModalClient from "./client"

interface PageProps {
  params: Promise<{ executionId: string }>
}

async function Content({ params }: PageProps) {
  const { executionId } = await params

  return <ExecutionDetailModalClient executionId={executionId} />
}

export default function ExecutionDetailModalPage(props: PageProps) {
  return (
    <Suspense fallback={null}>
      <Content {...props} />
    </Suspense>
  )
}
