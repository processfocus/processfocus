import { Suspense } from "react"
import ListDetailModalClient from "./client"

interface PageProps {
  params: Promise<{ id: string }>
  searchParams: Promise<{ list?: string }>
}

async function Content({ params, searchParams }: PageProps) {
  const { id } = await params
  const { list: listPath } = await searchParams
  const itemId = decodeURIComponent(id)
  const decodedListPath = listPath ? decodeURIComponent(listPath) : ""
  return <ListDetailModalClient listPath={decodedListPath} itemId={itemId} />
}

export default function ListDetailModalPage(props: PageProps) {
  return (
    <Suspense fallback={null}>
      <Content {...props} />
    </Suspense>
  )
}
