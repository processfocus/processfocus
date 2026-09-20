"use client"

import { createCollectionProvider } from "./collection-provider-factory"
import {
  type ProcessDocType,
  deletedField,
  pullQueryBuilder,
  pullStreamQueryBuilder,
} from "./process"

const {
  Provider: ProcessCollectionProvider,
  useCollection: useProcessCollection,
  cleanup: cleanupProcessCollection,
} = createCollectionProvider<ProcessDocType>({
  name: "Process",
  pullQueryBuilder,
  pullStreamQueryBuilder,
  deletedField,
  appSyncChannel: "/rxdb/collection/process",
  pullResultKey: "pullProcess",
  getRxCollection: (db) => db.process,
})

export {
  ProcessCollectionProvider,
  type ProcessDocType,
  cleanupProcessCollection,
  useProcessCollection,
}
