"use client"

import dynamic from "next/dynamic"
import { DashboardSkeleton } from "@/components/dashboard-skeleton"

// Only render this subtree on the client
const ClientIndex = dynamic(() => import("./client-index"), {
  ssr: false,
  loading: () => <DashboardSkeleton />,
})

export default function ClientPage() {
  return <ClientIndex />
}
