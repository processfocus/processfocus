"use client"

import { TodoCollectionProvider } from "@/lib/collections/todo-collection-provider"
import { TodoNotificationsManager } from "@/lib/notifications/use-todo-notifications"

export function TodoNotificationsRuntime() {
  return (
    <div className="peer fixed inset-0 z-50 overflow-auto bg-background empty:hidden">
      <TodoCollectionProvider>
        <TodoNotificationsManager>{null}</TodoNotificationsManager>
      </TodoCollectionProvider>
    </div>
  )
}
