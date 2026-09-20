"use client"

import { createCollectionProvider } from "./collection-provider-factory"
import {
  type DraftProcessExecutionDocType,
  deletedField,
  pullQueryBuilder,
  pullStreamQueryBuilder,
  pushQueryBuilder,
} from "./draft-process-execution"

const {
  Provider: DraftProcessCollectionProvider,
  useCollection: useDraftProcessCollection,
  cleanup: cleanupDraftProcessCollection,
} = createCollectionProvider<DraftProcessExecutionDocType>({
  name: "DraftProcessExecution",
  pullQueryBuilder,
  pullStreamQueryBuilder,
  pushQueryBuilder,
  deletedField,
  appSyncChannel: "/rxdb/collection/draftProcessExecution",
  pullResultKey: "pullDraftProcessExecution",
  pushResultKey: "pushDraftProcessExecution",
  getRxCollection: (db) => db.draftProcessExecution,
})

export {
  DraftProcessCollectionProvider,
  cleanupDraftProcessCollection,
  useDraftProcessCollection,
}
