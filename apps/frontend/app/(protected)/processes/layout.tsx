"use client"

import { DraftProcessCollectionProvider } from "@/lib/collections/draft-process-execution-collection-provider"
import { ProcessCollectionProvider } from "@/lib/collections/process-collection-provider"

export default function ProcessesLayout({
  children,
  modal,
}: {
  children: React.ReactNode
  modal: React.ReactNode
}) {
  return (
    <ProcessCollectionProvider>
      <DraftProcessCollectionProvider>
        {children}
        {modal}
      </DraftProcessCollectionProvider>
    </ProcessCollectionProvider>
  )
}
