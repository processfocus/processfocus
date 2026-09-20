"use client"

import type { Collection } from "@tanstack/db"
import { useLiveQuery } from "@tanstack/react-db"
import { Suspense, use } from "react"
import {
  TodoCollectionProvider,
  type TodoDocType,
  useTodoCollection,
} from "@/lib/collections/todo-collection-provider"
import { getMobileHomeOpenTaskCount } from "@/lib/mobile-home-view-model"

function TodoCountBadgeInner({
  collectionPromise,
}: {
  collectionPromise: Promise<Collection<TodoDocType, string>>
}) {
  const collection = use(collectionPromise)
  const query = useLiveQuery((q) =>
    q.from({ todo: collection }).select(({ todo }) => ({
      status: todo.status,
    })),
  )

  if (!query.isReady) return null

  const urgentCount = getMobileHomeOpenTaskCount(query.data ?? [])
  if (urgentCount === 0) return null

  return (
    <span
      aria-live="polite"
      aria-atomic="true"
      className="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-blue-600 px-1.5 text-xs font-semibold text-white"
    >
      <span className="sr-only">
        {`${urgentCount} urgent ${urgentCount === 1 ? "todo" : "todos"}`}
      </span>
      <span aria-hidden="true">{urgentCount}</span>
    </span>
  )
}

function TodoCountBadgeContent() {
  const { collectionPromise } = useTodoCollection()
  return (
    <Suspense fallback={null}>
      <TodoCountBadgeInner collectionPromise={collectionPromise} />
    </Suspense>
  )
}

export default function TodoCountBadge() {
  return (
    <TodoCollectionProvider>
      <TodoCountBadgeContent />
    </TodoCollectionProvider>
  )
}
