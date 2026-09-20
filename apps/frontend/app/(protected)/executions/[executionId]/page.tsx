import { ExecutionsPageContent } from "../page"

export default async function ExecutionDetailPage({
  params,
}: {
  params: Promise<{ executionId: string }>
}) {
  const { executionId } = await params

  return <ExecutionsPageContent initialSelectedExecutionId={executionId} />
}
