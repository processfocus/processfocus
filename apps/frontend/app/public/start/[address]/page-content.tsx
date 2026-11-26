import { ClientError } from "graphql-request"
import { notFound, redirect } from "next/navigation"
import { AnonymousPageClient } from "./page-client"
import { fetchAnonymousPage } from "@/lib/anonymous-page-server"

export type AnonymousRouteProps = {
  params: Promise<{ address: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export async function AnonymousPageContent({
  params,
  searchParams,
  view,
}: AnonymousRouteProps & { view: "start" | "form" }) {
  const { address } = await params
  // Consume searchParams: each button activation has its own visit key, so a
  // previously visited form cannot satisfy this navigation from the client cache.
  const query = await searchParams
  if (view === "start" && query["view"] === "form") {
    redirect(`/public/start/${encodeURIComponent(address)}/form`)
  }
  const page = await fetchAnonymousPage(address).catch((error: unknown) => {
    if (
      error instanceof ClientError &&
      error.response.errors?.some(
        (item) => item.extensions?.["code"] === "NotAuthorized",
      )
    )
      notFound()
    throw error
  })
  return (
    <AnonymousPageClient
      key={typeof query["visit"] === "string" ? query["visit"] : view}
      address={address}
      page={page}
      routeView={view}
    />
  )
}
