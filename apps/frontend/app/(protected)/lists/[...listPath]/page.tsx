import { Effect } from "effect"
import { AlertCircle } from "lucide-react"
import { Suspense } from "react"
import { ListControlsClient, ListTableClient } from "./list-page-client"
import { getSessionWithToken } from "@/lib/auth/session"
import { BasePage, runEffect } from "@/lib/effect/runtime"
import { GraphQLService } from "@/lib/effect/services/graphql"
import {
  type AvailableList,
  availableListsQuery,
  buildListQueryVariables,
  fetchListData,
  parseListPageNumber,
  parseListPageSize,
  parseListSort,
} from "@/lib/graphql/list-queries"
import { createServerGraphqlClient } from "@/lib/graphql/server-client"

interface PageProps {
  readonly params: Promise<{ readonly listPath: readonly string[] }>
  readonly searchParams: Promise<{
    readonly page?: string
    readonly limit?: string
    readonly filter?: string
    readonly sort?: string
    readonly dir?: string
  }>
}

interface ListDataSectionProps {
  readonly currentList: AvailableList
  readonly listPath: string
  readonly page: number
  readonly limit: number
  readonly filter: string
  readonly sortField: string | null
  readonly sortDirection: string | null
}

function ListDataSkeleton() {
  "use memo"

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900/60">
      <div className="space-y-3">
        <div className="h-9 w-full animate-pulse rounded bg-slate-100 dark:bg-slate-800" />
        <div className="h-12 w-full animate-pulse rounded bg-slate-100 dark:bg-slate-800" />
        <div className="h-12 w-full animate-pulse rounded bg-slate-100 dark:bg-slate-800" />
        <div className="h-12 w-full animate-pulse rounded bg-slate-100 dark:bg-slate-800" />
      </div>
    </div>
  )
}

function ListControlsSkeleton({
  currentList,
}: {
  readonly currentList: AvailableList
}) {
  "use memo"

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white">
          {currentList.name}
        </h1>
        {currentList.purpose ? (
          <p className="mt-1 text-slate-500 dark:text-slate-400">
            {currentList.purpose}
          </p>
        ) : null}
      </div>
      <div className="mb-6 h-10 max-w-md animate-pulse rounded bg-slate-100 dark:bg-slate-800" />
    </>
  )
}

function ListNotFound({ listPath }: { readonly listPath: string }) {
  "use memo"

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4">
      <AlertCircle className="h-12 w-12 text-red-500" />
      <h1 className="text-xl font-semibold">List Not Found</h1>
      <p className="text-slate-500">
        The list &quot;{listPath}&quot; was not found or you don&apos;t have
        access to it.
      </p>
    </div>
  )
}

function ListLoadError() {
  "use memo"

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4">
      <AlertCircle className="h-12 w-12 text-red-500" />
      <h1 className="text-xl font-semibold">Unable To Load Lists</h1>
      <p className="text-slate-500">
        We couldn&apos;t load the available lists. Try refreshing the page.
      </p>
    </div>
  )
}

async function ListDataSection({
  currentList,
  listPath,
  page,
  limit,
  filter,
  sortField,
  sortDirection,
}: ListDataSectionProps) {
  "use memo"

  const sort = parseListSort(sortField, sortDirection)
  const session = await runEffect(
    getSessionWithToken.pipe(Effect.catchAll(() => Effect.succeed(null))),
  )

  if (!session) {
    return (
      <div className="mb-4 rounded-lg bg-red-50 p-4 text-red-700 dark:bg-red-900/20 dark:text-red-400">
        <p className="font-medium">Error loading list data</p>
        <p className="text-sm">No authenticated session is available.</p>
      </div>
    )
  }

  try {
    // Nested Server Components render outside BasePage's Effect context, so
    // they need their own authenticated GraphQL client.
    const client = createServerGraphqlClient(session.accessToken)
    const listResult = await fetchListData(
      client,
      currentList,
      buildListQueryVariables({ page, limit, filter, sort }),
    )

    return (
      <ListTableClient
        currentList={currentList}
        listPath={listPath}
        listResult={listResult}
        sort={sort}
      />
    )
  } catch (error) {
    console.error("Failed to load list data", error)
    return (
      <div className="mb-4 rounded-lg bg-red-50 p-4 text-red-700 dark:bg-red-900/20 dark:text-red-400">
        <p className="font-medium">Error loading list data</p>
        <p className="text-sm">Unable to load list data.</p>
      </div>
    )
  }
}

const ListPage = Effect.fn("ListPage")(function* (props: PageProps) {
  const [{ listPath: listPathArray }, searchParams] = yield* Effect.all([
    Effect.promise(() => props.params),
    Effect.promise(() => props.searchParams),
  ])
  const graphql = yield* GraphQLService
  const listPath = `/${listPathArray.join("/")}`
  const page = parseListPageNumber(searchParams.page, 1)
  const limit = parseListPageSize(searchParams.limit, 20)
  const filter = searchParams.filter ?? ""
  const sort = parseListSort(
    searchParams.sort ?? null,
    searchParams.dir ?? null,
  )
  const availableLists = yield* graphql
    .request<{ readonly availableLists: readonly AvailableList[] }>(
      availableListsQuery,
    )
    .pipe(
      Effect.map((data) => data.availableLists),
      Effect.catchAll((error) =>
        Effect.sync(() => {
          console.error("Failed to load available lists", error)
          return null
        }),
      ),
    )

  if (!availableLists) {
    return <ListLoadError />
  }

  const currentList = availableLists.find((list) => list.path === listPath)

  if (!currentList) {
    return <ListNotFound listPath={listPath} />
  }

  return (
    <div className="container mx-auto py-6">
      {/* ListControlsClient reads URL state with useSearchParams. */}
      <Suspense fallback={<ListControlsSkeleton currentList={currentList} />}>
        <ListControlsClient
          key={listPath}
          currentList={currentList}
          listPath={listPath}
          filter={filter}
          sort={sort}
        />
      </Suspense>

      <Suspense key={listPath} fallback={<ListDataSkeleton />}>
        <ListDataSection
          currentList={currentList}
          listPath={listPath}
          page={page}
          limit={limit}
          filter={filter}
          sortField={searchParams.sort ?? null}
          sortDirection={searchParams.dir ?? null}
        />
      </Suspense>
    </div>
  )
})

export default BasePage.build(ListPage)
