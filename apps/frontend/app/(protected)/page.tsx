import ClientPage from "./client"
import { ExecutionCollectionProvider } from "@/lib/collections/execution-collection-provider"
import { ProcessCollectionProvider } from "@/lib/collections/process-collection-provider"

// The authenticated layout can omit children while redirecting or reissuing a
// session, so this page is not rendered in every instant-validation pass.
export const instant = false

export default function Page() {
  return (
    <ProcessCollectionProvider>
      <ExecutionCollectionProvider>
        <ClientPage />
      </ExecutionCollectionProvider>
    </ProcessCollectionProvider>
  )
}
