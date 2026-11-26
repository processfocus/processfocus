import { ExecutionsPageContent } from "../executions-client"

export const instant = false

export default async function ExecutionDetailPage({
  params,
}: {
  params: Promise<{ executionId: string }>
}) {
  const { executionId } = await params

  return <ExecutionsPageContent initialSelectedExecutionId={executionId} />
}
