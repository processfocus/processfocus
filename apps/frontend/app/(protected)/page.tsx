import ClientPage from "./client"
import { ExecutionCollectionProvider } from "@/lib/collections/execution-collection-provider"
import { ProcessCollectionProvider } from "@/lib/collections/process-collection-provider"

export default function Page() {
  return (
    <ProcessCollectionProvider>
      <ExecutionCollectionProvider>
        <ClientPage />
      </ExecutionCollectionProvider>
    </ProcessCollectionProvider>
  )
}
