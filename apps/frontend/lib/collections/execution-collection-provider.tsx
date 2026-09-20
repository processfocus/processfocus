"use client"

import { BTreeIndex } from "@tanstack/db"
import { createCollectionProvider } from "./collection-provider-factory"
import {
  type ExecutionDocType,
  deletedField,
  pullQueryBuilder,
  pullStreamQueryBuilder,
} from "./execution"

const {
  Provider: ExecutionCollectionProvider,
  useCollection: useExecutionCollection,
  cleanup: cleanupExecutionCollection,
} = createCollectionProvider<ExecutionDocType>({
  name: "Execution",
  pullQueryBuilder,
  pullStreamQueryBuilder,
  deletedField,
  resetReplicationOnReadyKey: "can-abandon-execution-v10",
  appSyncChannel: "/rxdb/collection/execution",
  pullResultKey: "pullExecution",
  getRxCollection: (db) => db.execution,
  createIndexes: (collection) => {
    collection.createIndex((execution) => execution.finishedAt, {
      indexType: BTreeIndex,
      name: "finishedAt",
    })
    collection.createIndex((execution) => execution.startedAt, {
      indexType: BTreeIndex,
      name: "startedAt",
    })
  },
})

export {
  ExecutionCollectionProvider,
  type ExecutionDocType,
  cleanupExecutionCollection,
  useExecutionCollection,
}
