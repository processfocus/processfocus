"use client"

import type { Collection } from "@tanstack/db"
import { useLiveQuery } from "@tanstack/react-db"
import Link from "next/link"
import { Suspense, use, useMemo, useState } from "react"
import { deepEqual } from "rxdb/plugins/utils"
import {
  type MobileProcessCatalogItem,
  createMobileProcessCatalog,
} from "./lib/mobile-process-catalog"
import { ProcessWorkflowLink } from "@/components/process-workflow-link"
import {
  type ProcessDocType,
  useProcessCollection,
} from "@/lib/collections/process-collection-provider"
import { cn } from "@/lib/utils"

function ProcessesSkeleton() {
  return (
    <div className="flex-1 overflow-y-auto">
      <section className="space-y-6">
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900/60">
          <div className="flex items-center justify-center py-12">
            <div className="text-center">
              <output
                className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-blue-600 border-r-transparent motion-reduce:animate-[spin_1.5s_linear_infinite]"
                aria-label="Loading processes"
              />
              <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">
                Loading processes...
              </p>
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}

function ProcessesPageInner({
  collectionPromise,
}: {
  collectionPromise: Promise<Collection<ProcessDocType, string>>
}) {
  "use memo"

  const [query, setQuery] = useState("")
  const [filterFavorites, setFilterFavorites] = useState(false)

  const processesCollection = use(collectionPromise)

  const { initialSync, retryInitialSync } = useProcessCollection()

  const processesQuery = useLiveQuery({
    query: (q) => q.from({ process: processesCollection }),
  })

  // The provider confirms persistence and adapter commits. A live query can
  // still be applying those commits; compare its full local snapshot before
  // authorizing empty/filter-empty wording. Keep its existing rows visible.
  const isLoadingProcesses =
    !processesQuery.isReady ||
    processesQuery.data.length !== processesCollection.size ||
    !processesQuery.data.every((process) =>
      deepEqual(process, processesCollection.get(process.id)),
    )

  const filtered = useMemo(() => {
    const processes = processesQuery.data ?? []
    return processes.filter((process) => {
      const matchesQuery =
        query.trim().length === 0 ||
        process.name.toLowerCase().includes(query.toLowerCase()) ||
        process.purpose.toLowerCase().includes(query.toLowerCase())
      const matchesFavorite = !filterFavorites || process.isFavorite
      return matchesQuery && matchesFavorite
    })
  }, [processesQuery.data, filterFavorites, query])

  const grouped = useMemo(() => {
    return filtered.reduce<Record<string, ProcessDocType[]>>((acc, item) => {
      const category = item.category
      if (!acc[category]) {
        acc[category] = []
      }
      acc[category].push(item)
      return acc
    }, {})
  }, [filtered])

  const categoryEntries = useMemo(() => {
    return Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b))
  }, [grouped])

  // Mobile intentionally omits search and filters in this first pass.
  const mobileCatalog = useMemo(
    () => createMobileProcessCatalog(filtered),
    [filtered],
  )

  const hasRows = (processesQuery.data?.length ?? 0) > 0
  const emptyTitle =
    query.trim() || filterFavorites
      ? "No matching processes"
      : "No processes found"
  const emptyDescription =
    query.trim() || filterFavorites
      ? "Try a different search or turn off Favorites."
      : "There are no processes for your organisational unit or role."
  const syncError =
    initialSync.status === "error" ? (
      <div role="alert" className="rounded-2xl border border-amber-300 p-4">
        <p>
          Processes could not finish loading. Check your connection and retry.
        </p>
        <button
          type="button"
          onClick={retryInitialSync}
          className="mt-2 font-semibold text-blue-600"
        >
          Retry loading processes
        </button>
      </div>
    ) : null

  if (!hasRows && syncError) return syncError
  if (!hasRows && (isLoadingProcesses || initialSync.status !== "complete")) {
    return <ProcessesSkeleton />
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <section className="space-y-6">
        {syncError}
        {initialSync.status === "loading" && (
          <p role="status" className="text-sm text-slate-500">
            Loading processes…
          </p>
        )}
        <div className="hidden rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900/60 md:block">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <h2 className="text-2xl font-semibold text-slate-900 dark:text-slate-50">
              Start a process
            </h2>
            <div className="flex flex-wrap gap-3">
              <label className="flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1 text-sm text-slate-500 shadow-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
                🔍
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search processes"
                  className="bg-transparent outline-none"
                />
              </label>
              <button
                type="button"
                onClick={() => setFilterFavorites((value) => !value)}
                className={cn(
                  "rounded-full border px-3 py-1.5 text-sm font-medium",
                  filterFavorites
                    ? "border-amber-500 bg-amber-500/10 text-amber-600 dark:border-amber-400 dark:bg-amber-500/10 dark:text-amber-200"
                    : "border-slate-200 text-slate-600 hover:border-slate-300 hover:text-slate-800 dark:border-slate-700 dark:text-slate-300 dark:hover:border-slate-600",
                )}
              >
                ★ Favorites
              </button>
            </div>
          </div>
          <p className="mt-3 max-w-3xl text-sm text-slate-500 dark:text-slate-400">
            Processes are grouped by department. Start immediately if no intake
            form is required, or open the form to enter or pick up your details.
          </p>
        </div>
        <div className="space-y-4 md:hidden">
          {mobileCatalog.map((process) => (
            <MobileProcessRow key={process.id} process={process} />
          ))}
          {mobileCatalog.length === 0 &&
            initialSync.status === "complete" &&
            !isLoadingProcesses && (
              <EmptyState title={emptyTitle} description={emptyDescription} />
            )}
        </div>
        <div className="hidden gap-6 md:grid lg:grid-cols-[2fr_1fr]">
          <div className="space-y-5">
            {categoryEntries.map(([category, categoryProcesses]) => (
              <div key={category} className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                    {category}
                  </h3>
                  <button
                    type="button"
                    className="text-xs font-semibold text-blue-500 hover:text-blue-600"
                  >
                    View documentation →
                  </button>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  {categoryProcesses.map((process) => (
                    <ProcessCard key={process.id} process={process} />
                  ))}
                </div>
              </div>
            ))}
            {categoryEntries.length === 0 &&
              initialSync.status === "complete" &&
              !isLoadingProcesses && (
                <EmptyState title={emptyTitle} description={emptyDescription} />
              )}
          </div>
          <div className="space-y-5">
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900/70">
              <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                Help & resources
              </h3>
              <ul className="mt-3 space-y-3 text-sm text-slate-600 dark:text-slate-300">
                <li className="flex items-center justify-between">
                  <span>Getting started with forms</span>
                  <button
                    type="button"
                    className="text-xs font-semibold text-blue-500 hover:text-blue-600"
                  >
                    Read guide →
                  </button>
                </li>
                <li className="flex items-center justify-between">
                  <span>Effect schema annotations</span>
                  <button
                    type="button"
                    className="text-xs font-semibold text-blue-500 hover:text-blue-600"
                  >
                    Schema tips →
                  </button>
                </li>
                <li className="flex items-center justify-between">
                  <span>Delegation best practices</span>
                  <button
                    type="button"
                    className="text-xs font-semibold text-blue-500 hover:text-blue-600"
                  >
                    Download PDF
                  </button>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}

export default function ProcessesPageClient() {
  const { collectionPromise } = useProcessCollection()

  return (
    <Suspense fallback={<ProcessesSkeleton />}>
      <ProcessesPageInner collectionPromise={collectionPromise} />
    </Suspense>
  )
}

function MobileProcessRow({ process }: { process: MobileProcessCatalogItem }) {
  return (
    <article className="relative overflow-hidden rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900/70">
      <Link
        href={process.startHref}
        prefetch={false}
        aria-hidden="true"
        tabIndex={-1}
        data-testid={`mobile-process-row-link-${process.id}`}
        className="absolute inset-0 rounded-2xl"
      />
      <div className="relative z-10 space-y-3">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            {process.title}
          </h3>
          <p className="mt-1 text-sm leading-6 text-slate-500 dark:text-slate-400">
            {process.description}
          </p>
        </div>
        <div className="flex justify-end">
          <Link
            href={process.startHref}
            prefetch={false}
            aria-label={`Start ${process.title}`}
            className="rounded-full bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-blue-500"
          >
            Start
          </Link>
        </div>
      </div>
    </article>
  )
}

function ProcessCard({ process }: { process: ProcessDocType }) {
  return (
    <article className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md dark:border-slate-800 dark:bg-slate-900/70">
      <div className="flex items-start justify-between">
        <div>
          <h4 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            {process.name}
          </h4>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {process.purpose}
          </p>
        </div>
        <ProcessWorkflowLink
          processName={process.name}
          processPath={process.path}
        />
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
        <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 px-2 py-1 dark:border-slate-700">
          ⏱ {process.duration}
        </span>
        <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 px-2 py-1 dark:border-slate-700">
          📊 {process.activeInstances} active
        </span>
        <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 px-2 py-1 dark:border-slate-700">
          {(process.formFieldCount ?? 0) > 0
            ? `📝 ${process.formFieldCount} kickoff fields`
            : "⚡️ No form required"}
        </span>
      </div>
      <div className="mt-auto flex items-center justify-between">
        <Link
          href={`/processes/start/${process.startStepPath}`}
          prefetch={false}
          className="rounded-full bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow hover:bg-blue-500"
        >
          {(process.formFieldCount ?? 0) > 0 ? "Start process" : "Start now"}
        </Link>
      </div>
    </article>
  )
}

function EmptyState({
  title,
  description,
}: {
  title: string
  description: string
}) {
  return (
    <div className="col-span-full flex flex-col items-center justify-center rounded-3xl border border-dashed border-slate-300 bg-white/60 p-12 text-center dark:border-slate-700 dark:bg-slate-900/40">
      <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
        {title}
      </h3>
      <p className="mt-2 max-w-md text-sm text-slate-500 dark:text-slate-400">
        {description}
      </p>
    </div>
  )
}
