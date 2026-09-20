import { Loader2 } from "lucide-react"
import { Suspense } from "react"
import ListDetailClient from "./client"

interface PageProps {
  params: Promise<{ id: string }>
  searchParams: Promise<{ list?: string }>
}

function LoadingState() {
  return (
    <div className="flex-1">
      <div className="mx-auto max-w-2xl">
        <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm dark:border-slate-800 dark:bg-slate-900/60">
          <div className="mb-6">
            <h1 className="text-3xl font-semibold text-slate-900 dark:text-slate-50">
              Item Details
            </h1>
            <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
              Loading...
            </p>
          </div>
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
          </div>
        </div>
      </div>
    </div>
  )
}

async function Content({ params, searchParams }: PageProps) {
  const { id } = await params
  const { list: listPath } = await searchParams
  const itemId = decodeURIComponent(id)
  const decodedListPath = listPath ? decodeURIComponent(listPath) : ""
  return <ListDetailClient listPath={decodedListPath} itemId={itemId} />
}

export default function ListDetailPage(props: PageProps) {
  return (
    <Suspense fallback={<LoadingState />}>
      <Content {...props} />
    </Suspense>
  )
}
