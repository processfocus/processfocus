import { Suspense } from "react"
import ProcessesClientLayout from "./client-layout"

// The authenticated shell can omit this subtree before a session is ready.
export const instant = false

export default function ProcessesLayout({
  children,
  modal,
}: {
  children: React.ReactNode
  modal: React.ReactNode
}) {
  return (
    <Suspense fallback={<p role="status">Loading...</p>}>
      <ProcessesClientLayout modal={modal}>{children}</ProcessesClientLayout>
    </Suspense>
  )
}
