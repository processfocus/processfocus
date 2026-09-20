"use client"

import type { Collection } from "@tanstack/db"
import { useLiveQuery } from "@tanstack/react-db"
import { useRouter } from "next/navigation"
import { Suspense, use, useEffect, useState } from "react"
import { useSession } from "@/components/auth-provider"
import { useRuntimeConfig } from "@/components/config-provider"
import {
  type TodoDocType,
  useTodoCollection,
} from "@/lib/collections/todo-collection-provider"
import { getDesktopNotificationState } from "@/lib/notifications/notification-preference"
import { createTodoNotificationObserver } from "@/lib/notifications/todo-notification-observer"
import { toUrlPath } from "@/lib/utils"

interface NotificationTodoItem {
  id: string
  stepName: string
  stepPath: string
}

interface TodoNotificationsInnerProps {
  collectionPromise: Promise<Collection<TodoDocType, string>>
  userId: string
  orgId: string
}

function TodoNotificationsInner({
  collectionPromise,
  userId,
  orgId,
}: TodoNotificationsInnerProps) {
  const router = useRouter()
  const collection = use(collectionPromise)
  const [observer] = useState(() =>
    createTodoNotificationObserver({
      isEnabled: () => {
        return getDesktopNotificationState(userId, orgId).isEnabled
      },
      onNotificationClick: (todoId: string, stepPath: string) => {
        // stepPath has a leading slash from the database, so we strip it for the URL.
        window.focus()
        router.push(
          `/to-dos/complete/${toUrlPath(stepPath)}?todoId=${encodeURIComponent(todoId)}`,
        )
      },
    }),
  )

  const todosQuery = useLiveQuery((q) =>
    q.from({ todo: collection }).select(({ todo }) => ({
      id: todo.id,
      stepName: todo.stepName,
      stepPath: todo.stepPath,
    })),
  )

  useEffect(() => {
    if (!todosQuery.isReady) {
      return
    }

    const todos: NotificationTodoItem[] = todosQuery.data ?? []
    observer.processUpdate(todos)
  })

  // The observer only tracks in-memory IDs. Avoid calling its cleanup from a
  // React effect because Strict Mode runs a synthetic mount cleanup in dev,
  // which would discard the baseline before the first real live update.
  // On a real unmount, the component instance becomes unreachable, and a
  // key-based remount creates a fresh observer.

  return null
}

interface TodoNotificationsManagerProps {
  children: React.ReactNode
}

export function TodoNotificationsManager({
  children,
}: TodoNotificationsManagerProps): React.ReactNode {
  const { collectionPromise } = useTodoCollection()
  const session = useSession()
  const runtimeConfig = useRuntimeConfig()
  const userId = session.userId
  const orgId = runtimeConfig.orgId

  return (
    <>
      <Suspense fallback={null}>
        <TodoNotificationsInner
          key={`${userId}:${orgId}`}
          collectionPromise={collectionPromise}
          userId={userId}
          orgId={orgId}
        />
      </Suspense>
      {children}
    </>
  )
}
