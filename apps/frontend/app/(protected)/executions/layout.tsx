import type { ReactNode } from "react"
import ExecutionsClientLayout from "./client-layout"

// The authenticated shell can omit this subtree before a session is ready.
export const instant = false

export default function ExecutionsLayout({
  children,
  modal,
}: {
  children: ReactNode
  modal: ReactNode
}) {
  return (
    <ExecutionsClientLayout modal={modal}>{children}</ExecutionsClientLayout>
  )
}
