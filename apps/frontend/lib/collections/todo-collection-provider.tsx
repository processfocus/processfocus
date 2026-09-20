"use client"

import { createCollectionProvider } from "./collection-provider-factory"
import {
  type TodoDocType,
  deletedField,
  pullQueryBuilder,
  pullStreamQueryBuilder,
} from "./todo"

const {
  Provider: TodoCollectionProvider,
  useCollection: useTodoCollection,
  cleanup: cleanupTodoCollection,
} = createCollectionProvider<TodoDocType>({
  name: "Todo",
  pullQueryBuilder,
  pullStreamQueryBuilder,
  deletedField,
  appSyncChannel: "/rxdb/collection/todo",
  pullResultKey: "pullTodo",
  getRxCollection: (db) => db.todo,
})

export {
  TodoCollectionProvider,
  type TodoDocType,
  cleanupTodoCollection,
  useTodoCollection,
}
