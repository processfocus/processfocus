import { Suspense } from "react"
import { AnonymousPageContent, type AnonymousRouteProps } from "../page-content"

export default function AnonymousPage(props: AnonymousRouteProps) {
  return (
    <Suspense fallback={<p>Loading form…</p>}>
      <AnonymousPageContent {...props} view="form" />
    </Suspense>
  )
}
