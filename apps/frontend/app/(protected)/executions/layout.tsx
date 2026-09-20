"use client"

import type { ReactNode } from "react"
import { ExecutionCollectionProvider } from "@/lib/collections/execution-collection-provider"

export default function ExecutionsLayout({
  children,
  modal,
}: {
  children: ReactNode
  modal: ReactNode
}) {
  return (
    <ExecutionCollectionProvider>
      {children}
      {modal}
    </ExecutionCollectionProvider>
  )
}
