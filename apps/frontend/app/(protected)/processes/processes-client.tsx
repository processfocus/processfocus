"use client"

import type { Collection } from "@tanstack/db"
import { useLiveQuery } from "@tanstack/react-db"
import { formatDistanceToNow } from "date-fns"
import Link from "next/link"
import { Suspense, use, useMemo, useState } from "react"
import {
  type MobileProcessCatalogItem,
  createMobileProcessCatalog,
} from "./lib/mobile-process-catalog"
import { ProcessWorkflowLink } from "@/components/process-workflow-link"
import type { DraftProcessExecutionDocType } from "@/lib/collections/draft-process-execution"
import { useDraftProcessCollection } from "@/lib/collections/draft-process-execution-collection-provider"
import {
  type ProcessDocType,
  useProcessCollection,
} from "@/lib/collections/process-collection-provider"
import { cn } from "@/lib/utils"

function formatLastSaved(lastSaved: string): string {
  try {
    const date = new Date(lastSaved)
    if (Number.isNaN(date.getTime())) {
      return "Recently saved"
    }
    return formatDistanceToNow(date, { addSuffix: true })
  } catch {
    return "Recently saved"
  }
}

interface DraftCardData {
  id: string
  processId: string
  name: string
  startStepPath: string
  fieldsCompleted: number
  totalFields: number
  lastSaved: string
}

function DraftProcessExecutionCard({
  draft,
  onDiscard,
}: {
  draft: DraftCardData
  onDiscard: (id: string) => void
}) {
  // Construct the continue URL with draftId query param
  const continueUrl = `/processes/start/${draft.startStepPath}?draftId=${encodeURIComponent(draft.id)}`

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/40 p-3 text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-300">
      <div className="flex items-center justify-between">
        <div>
          <p className="font-semibold text-slate-900 dark:text-slate-100">
            {draft.name}
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {draft.fieldsCompleted} of {draft.totalFields} fields complete
          </p>
        </div>
        <span className="text-xs text-slate-500 dark:text-slate-400">
          {formatLastSaved(draft.lastSaved)}
        </span>
      </div>
      <div className="mt-3 flex items-center justify-between">
        <div className="h-2 w-48 rounded-full bg-slate-200 dark:bg-slate-700">
          <div
            className="h-2 rounded-full bg-blue-500"
            style={{
              width: `${(draft.fieldsCompleted / draft.totalFields) * 100}%`,
            }}
          />
        </div>
        <div className="flex gap-2">
          <Link
            href={continueUrl}
            prefetch={false}
            className="cursor-pointer rounded-full border border-slate-200 px-3 py-1 text-xs font-semibold text-slate-600 transition-colors hover:border-slate-300 hover:bg-slate-50 hover:text-slate-800 dark:border-slate-700 dark:text-slate-300 dark:hover:border-slate-600 dark:hover:bg-slate-800"
          >
            Continue
          </Link>
          <button
            type="button"
            onClick={() => onDiscard(draft.id)}
            className="cursor-pointer text-xs font-semibold text-rose-500 transition-colors hover:text-rose-600 dark:hover:text-rose-400"
          >
            Discard
          </button>
        </div>
      </div>
    </div>
  )
}

function DraftsSkeleton() {
  return (
    <div className="flex items-center justify-center py-6">
      <output
        className="inline-block h-6 w-6 animate-spin rounded-full border-4 border-solid border-blue-600 border-r-transparent motion-reduce:animate-[spin_1.5s_linear_infinite]"
        aria-label="Loading drafts"
      />
    </div>
  )
}

function DraftsListInner({
  collectionPromise,
}: {
  collectionPromise: Promise<Collection<DraftProcessExecutionDocType, string>>
}) {
  const draftProcessExecutionCollection = use(collectionPromise)

  const draftsQuery = useLiveQuery((q) =>
    q.from({ draft: draftProcessExecutionCollection }).select(({ draft }) => ({
      id: draft.id,
      processId: draft.processId,
      name: draft.name,
      startStepPath: draft.startStepPath,
      fieldsCompleted: draft.fieldsCompleted,
      totalFields: draft.totalFields,
      lastSaved: draft.lastSaved,
    })),
  )

  const handleDiscard = async (draftId: string) => {
    try {
      draftProcessExecutionCollection.delete(draftId)
    } catch (error) {
      console.error("Failed to discard draft:", error)
      alert(
        `Failed to discard draft: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  if (!draftsQuery.isReady) {
    return <DraftsSkeleton />
  }

  if (draftsQuery.data.length === 0) {
    return (
      <p className="text-sm text-slate-500 dark:text-slate-400">
        No drafts yet. Start a process and your progress will autosave here.
      </p>
    )
  }

  return (
    <>
      {draftsQuery.data.map((draft) => (
        <DraftProcessExecutionCard
          key={draft.id}
          draft={draft}
          onDiscard={handleDiscard}
        />
      ))}
    </>
  )
}

function DraftsList() {
  const { collectionPromise } = useDraftProcessCollection()

  return (
    <Suspense fallback={<DraftsSkeleton />}>
      <DraftsListInner collectionPromise={collectionPromise} />
    </Suspense>
  )
}

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

  // Suspend until collection is ready
  const processesCollection = use(collectionPromise)

  // Query processes from RxDB collection
  const processesQuery = useLiveQuery((q) =>
    q.from({ process: processesCollection }).select(({ process }) => ({
      id: process.id,
      updatedAt: process.updatedAt,
      name: process.name,
      path: process.path,
      activeInstances: process.activeInstances,
      category: process.category,
      duration: process.duration,
      formFieldCount: process.formFieldCount,
      purpose: process.purpose,
      isFavorite: process.isFavorite,
      orgUnit: process.orgUnit,
      startStepPath: process.startStepPath,
    })),
  )

  const isLoadingProcesses = !processesQuery.isReady

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

  // Show loading state while initial data is being fetched from RxDB
  if (isLoadingProcesses) {
    return <ProcessesSkeleton />
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <section className="space-y-6">
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
            form is required, or launch the kickoff wizard with autosave and
            schema driven validation.
          </p>
        </div>
        <div className="space-y-4 md:hidden">
          {mobileCatalog.map((process) => (
            <MobileProcessRow key={process.id} process={process} />
          ))}
          {mobileCatalog.length === 0 && (
            <EmptyState
              title="No processes found"
              description="There are no processes for your organisational unit or role."
            />
          )}
        </div>
        <div className="hidden gap-6 lg:grid-cols-[2fr_1fr] md:grid">
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
            {categoryEntries.length === 0 && (
              <EmptyState
                title="No processes found"
                description="There are no processes for your organisational unit or role."
              />
            )}
          </div>
          <div className="space-y-5">
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm dark:border-slate-800 dark:bg-slate-900/70">
              <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                Draft process starts
              </h3>
              <p className="text-sm text-slate-500 dark:text-slate-400">
                Resume where you left off. Drafts autosave every 30 seconds and
                can be shared for collaboration.
              </p>
              <div className="mt-4 space-y-3">
                <DraftsList />
              </div>
            </div>
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
