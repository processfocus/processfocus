"use client"

import { useSelectedLayoutSegment } from "next/navigation"
import { ProcessCollectionProvider } from "@/lib/collections/process-collection-provider"

export default function ProcessesClientLayout({
  children,
  modal,
}: {
  children: React.ReactNode
  modal: React.ReactNode
}) {
  const segment = useSelectedLayoutSegment()
  if (segment === "start") {
    return (
      <>
        {children}
        {modal}
      </>
    )
  }
  return (
    <ProcessCollectionProvider>
      {children}
      {modal}
    </ProcessCollectionProvider>
  )
}
