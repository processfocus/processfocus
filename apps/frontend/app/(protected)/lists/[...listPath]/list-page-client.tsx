"use client"

import { useMutation } from "@tanstack/react-query"
import { ClientError } from "graphql-request"
import {
  Check,
  ChevronsUpDown,
  Download,
  Loader2,
  RotateCw,
  Search,
  X,
} from "lucide-react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import {
  Button,
  Command,
  CommandGroup,
  CommandItem,
  CommandList,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  cn,
} from "@pf/shadcn-components"
import { ListCreateButton } from "../components/list-create-form"
import { useListSearchParams } from "../lib/list-process-dialog"
import { formatCellValue } from "../utils"
import { useListRefresh } from "@/app/(protected)/lists/lib/list-refresh-provider"
import { AnonymousPageLink } from "@/components/anonymous-page-link"
import {
  CollectionTableCard,
  type CollectionTableColumn,
} from "@/components/collections/collection-table-card"
import { useDevImportRevision } from "@/lib/dev/import-completed-query-invalidation"
import { useGraphqlClient } from "@/lib/graphql/client-provider"
import {
  type AvailableList,
  type ListDataResult,
  type ListSortInput,
  applyListFilterToSearchParams,
  applyListPageToSearchParams,
  applyListSortToSearchParams,
  assertGraphqlName,
  buildListQueryVariables,
  exportListCsv,
  fetchFreshListData,
  parseListPageNumber,
} from "@/lib/graphql/list-queries"

interface ListControlsClientProps {
  readonly currentList: AvailableList
  readonly listPath: string
  readonly filter: string
  readonly sort: ListSortInput | null
}

interface ListTableClientProps {
  readonly currentList: AvailableList
  readonly listPath: string
  readonly listResult: ListDataResult
  readonly sort: ListSortInput | null
}

interface ListBrowsingTableViewProps {
  readonly currentList: AvailableList
  readonly listPath: string
  readonly listResult: ListDataResult
  readonly sort: ListSortInput | null
  readonly onPageChange: (page: number) => void
  readonly onSortChange: (field: string) => void
}

interface SelectFieldProps {
  readonly label: string
  readonly value: string
  readonly options: readonly string[]
  readonly disabled: boolean
  readonly onChange: (value: string) => void
}

interface InlineSelectCellProps {
  readonly field: string
  readonly id: unknown
  readonly value: unknown
  readonly item: Record<string, unknown>
  readonly options: readonly string[]
  readonly onChange: (
    item: Record<string, unknown>,
    field: string,
    value: string,
  ) => void
}

const RowUpdatingIdContext = createContext<string | null>(null)

function SelectField({
  label,
  value,
  options,
  disabled,
  onChange,
}: SelectFieldProps) {
  const [open, setOpen] = useState(false)
  const displayedOptions =
    value === "" || options.includes(value) ? options : [value, ...options]
  const ariaLabel = `Update ${label.toLowerCase()}`

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={ariaLabel}
          className="h-8 min-w-[13.5rem] w-fit justify-between px-2 text-sm font-normal"
          disabled={disabled}
          onClick={(event) => event.stopPropagation()}
        >
          <span className="whitespace-nowrap">{value}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="min-w-[13.5rem] w-fit">
        <Command>
          <CommandList>
            <CommandGroup>
              {displayedOptions.map((opt) => (
                <CommandItem
                  key={opt}
                  value={opt}
                  onSelect={() => {
                    onChange(opt)
                    setOpen(false)
                  }}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      value === opt ? "opacity-100" : "opacity-0",
                    )}
                  />
                  {opt === "" ? "No value" : opt}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function InlineSelectCell({
  field,
  id,
  value,
  item,
  options,
  onChange,
}: InlineSelectCellProps) {
  const rowUpdatingId = useContext(RowUpdatingIdContext)

  return (
    <SelectField
      label={field}
      disabled={typeof id !== "string" || rowUpdatingId === id}
      options={options}
      value={typeof value === "string" ? value : ""}
      onChange={(selected) => onChange(item, field, selected)}
    />
  )
}

function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value)

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedValue(value)
    }, delay)

    return () => {
      clearTimeout(timer)
    }
  }, [value, delay])

  return debouncedValue
}

function getExportErrorMessage(error: unknown): string {
  if (error instanceof ClientError) {
    const code = error.response.errors?.[0]?.extensions?.["code"]

    switch (code) {
      case "ExportRowLimitError":
        return "This list has more than 10,000 rows, so it can't be exported as CSV."
      case "ExportNonScalarError":
        return "This list contains nested data that can't be exported as CSV yet."
      case "ListNotFoundError":
        return "This list was not found or you no longer have access to it."
    }
  }

  return "Export failed"
}

function parseFieldOptions(
  description: string | null | undefined,
): string[] | null {
  if (description == null || description === "") return null

  const options = description.split("|").map((opt) => opt.trim())
  const nonEmptyCount = options.filter((o) => o !== "").length

  return nonEmptyCount === 0 ? null : options
}

function triggerDownload(url: string): void {
  const link = document.createElement("a")
  link.href = url
  link.download = ""
  document.body.append(link)
  link.click()
  link.remove()
}

function isCurrentList(pathname: string, listPath: string) {
  try {
    return decodeURIComponent(pathname) === `/lists${listPath}`
  } catch {
    return false
  }
}

export function ListControlsClient({
  currentList,
  listPath,
  filter,
  sort,
}: ListControlsClientProps) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useListSearchParams()
  const refreshState = useListRefresh()
  const startProcess = currentList.startProcess
  // Both start actions use Next-integrated native history to keep this List mounted.
  // Their listReturn token lets the shared close handler return with router.back().
  const startSearchParams = new URLSearchParams({
    returnTo: `/lists${listPath}${searchParams.size ? `?${searchParams}` : ""}`,
  })
  const client = useGraphqlClient()
  const [inputValue, setInputValue] = useState(filter)
  const debouncedFilterValue = useDebounce(inputValue, 300)
  const isPushingUrl = useRef(false)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const revision = useDevImportRevision()
  const renderedRevision = useRef(revision)
  useEffect(() => {
    if (
      revision === renderedRevision.current ||
      creating ||
      !isCurrentList(pathname, listPath)
    )
      return
    // A retained table catches up once its create, detail or process dialog closes.
    renderedRevision.current = revision
    router.refresh()
  }, [revision, creating, pathname, listPath, router])

  useEffect(() => {
    if (!isPushingUrl.current) {
      setInputValue(filter)
    }
    isPushingUrl.current = false
  }, [filter])

  useEffect(() => {
    // Defer pending filters while this List is the background of a process dialog.
    if (!isCurrentList(pathname, listPath)) return
    if (debouncedFilterValue !== filter) {
      isPushingUrl.current = true
      const newSearch = applyListFilterToSearchParams(
        searchParams,
        debouncedFilterValue,
      )
      router.push(`/lists${listPath}?${newSearch}`, { scroll: false })
    }
  }, [debouncedFilterValue, filter, searchParams, router, listPath, pathname])

  const refreshList = useCallback(() => {
    router.refresh()
  }, [router])

  const handleExportCsv = useCallback(async () => {
    setExporting(true)
    setExportError(null)
    const exportFilter = filter !== "" ? filter : null
    try {
      const result = await exportListCsv(client, listPath, {
        filter: exportFilter,
        sort,
      })
      triggerDownload(result.downloadUrl)
    } catch (err) {
      setExportError(getExportErrorMessage(err))
    }
    setExporting(false)
  }, [client, listPath, sort, filter])

  return (
    <>
      <div className="mb-6">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">
            {currentList.name}
          </h1>
          {startProcess ? (
            <Button asChild size="sm">
              <Link
                href={`/processes/start/${startProcess.startStepPath.replace(/^\//, "")}?${startSearchParams}`}
                prefetch={false}
                onNavigate={(event) => {
                  event.preventDefault()
                  const params = new URLSearchParams(startSearchParams)
                  params.set(
                    "listReturn",
                    refreshState.rememberReturn(params.get("returnTo") ?? ""),
                  )
                  window.history.pushState(
                    null,
                    "",
                    `/processes/start/${startProcess.startStepPath.replace(/^\//, "")}?${params}`,
                  )
                }}
              >
                {startProcess.name}
              </Link>
            </Button>
          ) : null}
          {currentList.additionalStartProcesses.map((process) => (
            <Button asChild size="sm" key={process.startStepPath}>
              <Link
                href={`/processes/start/${process.startStepPath.replace(/^\//, "")}?${startSearchParams}`}
                prefetch={false}
                onNavigate={(event) => {
                  event.preventDefault()
                  const params = new URLSearchParams(startSearchParams)
                  params.set(
                    "listReturn",
                    refreshState.rememberReturn(params.get("returnTo") ?? ""),
                  )
                  window.history.pushState(
                    null,
                    "",
                    `/processes/start/${process.startStepPath.replace(/^\//, "")}?${params}`,
                  )
                }}
              >
                {process.name}
              </Link>
            </Button>
          ))}
          {currentList.anonymousPage ? (
            <AnonymousPageLink {...currentList.anonymousPage} />
          ) : null}
          {currentList.canCreate ? (
            <ListCreateButton
              open={creating}
              onOpenChange={setCreating}
              listPath={listPath}
              name={currentList.detailName ?? currentList.name}
            />
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            onClick={refreshList}
            aria-label="Refresh list"
          >
            <RotateCw className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleExportCsv}
            disabled={exporting}
            aria-label="Export CSV"
          >
            {exporting ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <Download className="mr-1.5 h-4 w-4" />
            )}
            Export CSV
          </Button>
        </div>
        {currentList.purpose && (
          <p className="mt-1 text-slate-500 dark:text-slate-400">
            {currentList.purpose}
          </p>
        )}
      </div>

      <div className="mb-6">
        <div className="flex items-center gap-2">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              type="text"
              value={inputValue}
              onChange={(event) => setInputValue(event.target.value)}
              placeholder="Filter results..."
              className="pl-10 pr-10"
            />
            {inputValue ? (
              <button
                type="button"
                onClick={() => setInputValue("")}
                className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-300"
                aria-label="Clear filter"
              >
                <X className="h-4 w-4" />
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {exportError ? (
        <div className="mb-4 rounded-lg bg-red-50 p-4 text-red-700 dark:bg-red-900/20 dark:text-red-400">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-medium">Export failed</p>
              <p className="text-sm">{exportError}</p>
            </div>
            <button
              type="button"
              className="rounded p-1 text-red-700 transition hover:bg-red-100 dark:text-red-400 dark:hover:bg-red-900/40"
              onClick={() => setExportError(null)}
              aria-label="Dismiss export error"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      ) : null}
    </>
  )
}

export function ListTableClient(
  props: ListTableClientProps & { readonly filter: string },
) {
  const state = useListRefresh()
  const searchParams = useListSearchParams()
  const page = parseListPageNumber(searchParams.get("page") ?? undefined, 1)
  const snapshot = useSyncExternalStore(
    state.subscribe,
    state.snapshot,
    state.serverSnapshot,
  )
  const client = useGraphqlClient()
  const variables = useMemo(
    () =>
      buildListQueryVariables({
        page,
        limit: props.listResult.limit,
        filter: props.filter,
        sort: props.sort,
      }),
    [page, props.listResult.limit, props.filter, props.sort],
  )
  const result = state.read(
    props.listPath,
    variables,
    props.listResult,
    snapshot,
  )
  useEffect(() => {
    void state.refresh(
      props.listPath,
      variables,
      props.listResult,
      (query) => fetchFreshListData(client, props.currentList, query),
      snapshot,
    )
  }, [
    state,
    snapshot,
    props.listPath,
    props.listResult,
    variables,
    client,
    props.currentList,
  ])
  useEffect(() => {
    if (
      result.kind !== "ready" ||
      result.data.page === variables.page ||
      decodeURIComponent(window.location.pathname) !== `/lists${props.listPath}`
    )
      return
    const url = new URL(window.location.href)
    if (url.searchParams.get("page") === String(result.data.page)) return
    url.searchParams.set("page", String(result.data.page))
    window.history.replaceState(null, "", `${url.pathname}${url.search}`)
  }, [result, variables.page, props.listPath])
  if (result.kind === "loading") return <p role="status">Refreshing list…</p>
  if (result.kind === "error")
    return (
      <div
        role="alert"
        className="rounded-lg bg-red-50 p-4 text-red-700 dark:bg-red-900/20 dark:text-red-400"
      >
        <p>Could not refresh the List. Any submitted changes were saved.</p>
        <Button
          variant="outline"
          onClick={() => state.invalidate(props.listPath)}
        >
          Retry
        </Button>
      </div>
    )
  return <ListTableContent {...props} listResult={result.data} />
}

function ListTableContent({
  currentList,
  listPath,
  listResult,
  sort,
}: ListTableClientProps) {
  if (!currentList.updateMutationName && !currentList.updateInputTypeName) {
    return (
      <ListReadOnlyTableClient
        currentList={currentList}
        listPath={listPath}
        listResult={listResult}
        sort={sort}
      />
    )
  }

  return (
    <ListEditableTableClient
      currentList={currentList}
      listPath={listPath}
      listResult={listResult}
      sort={sort}
    />
  )
}

function ListReadOnlyTableClient({
  currentList,
  listPath,
  listResult,
  sort,
}: ListTableClientProps) {
  const router = useRouter()
  const searchParams = useListSearchParams()

  const goToPage = useCallback(
    (newPage: number) => {
      const newSearch = applyListPageToSearchParams(searchParams, newPage)
      router.push(`/lists${listPath}?${newSearch}`)
    },
    [listPath, router, searchParams],
  )

  const changeSort = useCallback(
    (field: string) => {
      const newSearch = applyListSortToSearchParams(searchParams, field)
      router.push(`/lists${listPath}?${newSearch}`)
    },
    [listPath, router, searchParams],
  )

  return (
    <ListBrowsingTableView
      currentList={currentList}
      listPath={listPath}
      listResult={listResult}
      sort={sort}
      onPageChange={goToPage}
      onSortChange={changeSort}
    />
  )
}

function ListBrowsingTableView({
  currentList,
  listPath,
  listResult,
  sort,
  onPageChange,
  onSortChange,
}: ListBrowsingTableViewProps) {
  "use memo"

  const columns: CollectionTableColumn<Record<string, unknown>>[] =
    currentList.outputColumns
      .filter((column) => column.visibleInList)
      .map((column) => ({
        key: column.field,
        label: column.label,
        sortable: column.sortable,
        sortDirection:
          sort?.field === column.field
            ? sort.direction === "ASC"
              ? "asc"
              : "desc"
            : null,
        headerClassName:
          "text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400",
        cellClassName:
          "whitespace-nowrap text-sm text-slate-900 dark:text-slate-100",
        render: (item) => formatCellValue(item[column.field]),
      }))

  return (
    <CollectionTableCard
      columns={columns}
      items={listResult.items as Record<string, unknown>[]}
      page={listResult.page}
      totalCount={listResult.totalCount}
      limit={listResult.limit}
      hasNextPage={listResult.hasNextPage}
      onPageChange={onPageChange}
      onSortChange={onSortChange}
      getRowKey={(item, index) => String(item["id"] ?? `row-${index}`)}
      getRowHref={(item) => {
        if (!currentList.itemQueryName || !item["id"]) return null
        return `/lists/item/${encodeURIComponent(String(item["id"]))}?list=${encodeURIComponent(listPath)}`
      }}
      emptyMessage="No items found"
    />
  )
}

function ListEditableTableClient({
  currentList,
  listPath,
  listResult,
  sort,
}: ListTableClientProps) {
  const router = useRouter()
  const searchParams = useListSearchParams()
  const client = useGraphqlClient()
  const refreshState = useListRefresh()
  const [fieldUpdateError, setFieldUpdateError] = useState<string | null>(null)
  const [fieldUpdatingId, setFieldUpdatingId] = useState<string | null>(null)

  const updateFieldMutation = useMutation({
    mutationFn: async ({
      id,
      input,
    }: {
      readonly id: string
      readonly input: Record<string, unknown>
    }) => {
      if (!currentList.updateMutationName || !currentList.updateInputTypeName) {
        throw new Error("This list does not support updates")
      }

      assertGraphqlName(currentList.updateInputTypeName, "input type name")
      assertGraphqlName(currentList.updateMutationName, "mutation name")

      const mutation = `mutation UpdateListItem($id: String!, $input: ${currentList.updateInputTypeName}!) {
          ${currentList.updateMutationName}(id: $id, input: $input) {
            __typename
          }
        }`

      await client.request(mutation, { id, input })
    },
    onError: (err) => {
      console.error("Field update failed", err)
      setFieldUpdateError("Field update failed")
    },
    onSuccess: () => {
      setFieldUpdateError(null)
      refreshState.invalidate(listPath)
    },
    onSettled: (_data, _error, variables) => {
      setFieldUpdatingId((current) =>
        current === variables.id ? null : current,
      )
    },
  })

  const goToPage = useCallback(
    (newPage: number) => {
      const newSearch = applyListPageToSearchParams(searchParams, newPage)
      router.push(`/lists${listPath}?${newSearch}`)
    },
    [listPath, router, searchParams],
  )

  const changeSort = useCallback(
    (field: string) => {
      const newSearch = applyListSortToSearchParams(searchParams, field)
      router.push(`/lists${listPath}?${newSearch}`)
    },
    [listPath, router, searchParams],
  )

  const handleFieldChange = (
    item: Record<string, unknown>,
    field: string,
    value: string,
  ) => {
    const id = item["id"]
    if (typeof id !== "string") return
    setFieldUpdatingId(id)
    const input: Record<string, unknown> = { [field]: value }
    for (const column of currentList.editableColumns) {
      if (column.field !== field && column.field in item) {
        input[column.field] = item[column.field]
      }
    }
    updateFieldMutation.mutate({ id, input })
  }

  const columnFieldOptions = useMemo(() => {
    const map: Record<string, string[]> = {}

    for (const column of currentList.editableColumns) {
      const options = parseFieldOptions(
        currentList.outputColumns.find((c) => c.field === column.field)
          ?.description,
      )
      if (options) {
        map[column.field] = options
      }
    }

    return map
  }, [currentList])

  const columns: CollectionTableColumn<Record<string, unknown>>[] =
    currentList.outputColumns
      .filter((column) => column.visibleInList)
      .map((column) => ({
        key: column.field,
        label: column.label,
        sortable: column.sortable,
        sortDirection:
          sort?.field === column.field
            ? sort.direction === "ASC"
              ? "asc"
              : "desc"
            : null,
        headerClassName:
          "text-xs font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400",
        cellClassName:
          "whitespace-nowrap text-sm text-slate-900 dark:text-slate-100",
        render: (item) => {
          const fieldOptions = columnFieldOptions[column.field]

          if (
            currentList.updateMutationName &&
            currentList.updateInputTypeName &&
            fieldOptions
          ) {
            return (
              <InlineSelectCell
                field={column.field}
                id={item["id"]}
                item={item}
                options={fieldOptions}
                value={item[column.field]}
                onChange={handleFieldChange}
              />
            )
          }

          return formatCellValue(item[column.field])
        },
      }))

  return (
    <>
      {fieldUpdateError ? (
        <div className="mb-4 rounded-lg bg-red-50 p-4 text-red-700 dark:bg-red-900/20 dark:text-red-400">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-medium">Field update failed</p>
              <p className="text-sm">{fieldUpdateError}</p>
            </div>
            <button
              type="button"
              className="rounded p-1 text-red-700 transition hover:bg-red-100 dark:text-red-400 dark:hover:bg-red-900/40"
              onClick={() => setFieldUpdateError(null)}
              aria-label="Dismiss field update error"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      ) : null}

      <RowUpdatingIdContext.Provider value={fieldUpdatingId}>
        <CollectionTableCard
          columns={columns}
          items={listResult.items as Record<string, unknown>[]}
          page={listResult.page}
          totalCount={listResult.totalCount}
          limit={listResult.limit}
          hasNextPage={listResult.hasNextPage}
          onPageChange={goToPage}
          onSortChange={changeSort}
          getRowKey={(item, index) => String(item["id"] ?? `row-${index}`)}
          getRowHref={(item) => {
            if (!currentList.itemQueryName || !item["id"]) return null
            return `/lists/item/${encodeURIComponent(String(item["id"]))}?list=${encodeURIComponent(listPath)}`
          }}
          emptyMessage="No items found"
        />
      </RowUpdatingIdContext.Provider>
    </>
  )
}
