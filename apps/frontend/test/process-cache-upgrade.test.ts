import { type RxCollection, addRxPlugin, createRxDatabase } from "rxdb"
import { RxDBMigrationSchemaPlugin } from "rxdb/plugins/migration-schema"
import { replicateRxCollection } from "rxdb/plugins/replication"
import { getRxStorageMemory } from "rxdb/plugins/storage-memory"
import {
  type ProcessDocType,
  migrationStrategies,
  processSchema,
  replicationIdentifier,
} from "../lib/collections/process"
import { expect, it } from "bun:test"

addRxPlugin(RxDBMigrationSchemaPlugin)

it("drops pre-history Processes and repulls current access instead of migrating an obsolete checkpoint", async () => {
  const storage = getRxStorageMemory()
  const name = `process-upgrade-${crypto.randomUUID()}`
  const doc = (id: string): ProcessDocType => ({
    id,
    updatedAt: 1,
    name: id,
    path: `/${id}`,
    purpose: "",
    category: "",
    duration: "Unknown",
    activeInstances: 0,
    formFieldCount: 0,
    isFavorite: false,
    orgUnit: { id: "org", name: "Org", level: "root" },
    startStepPath: `/${id}/Start`,
  })
  const old = await createRxDatabase<{ process: RxCollection<ProcessDocType> }>(
    { name, storage, multiInstance: false },
  )
  await old.addCollections({
    process: { schema: { ...processSchema, version: 3 }, migrationStrategies },
  })
  const oldReplication = replicateRxCollection<
    ProcessDocType,
    { revision: number }
  >({
    collection: old.process,
    replicationIdentifier: "Process",
    live: false,
    waitForLeadership: false,
    pull: {
      handler: async (checkpoint) => ({
        documents: checkpoint ? [] : [doc("formerly-authorized")],
        checkpoint: { revision: 1 },
      }),
    },
  })
  await oldReplication.awaitInitialReplication()
  expect(await old.process.find().exec()).toHaveLength(1)
  await oldReplication.cancel()
  await old.close()

  const current = await createRxDatabase<{
    process: RxCollection<ProcessDocType>
  }>({ name, storage, multiInstance: false })
  try {
    await current.addCollections({
      process: { schema: processSchema, migrationStrategies },
    })
    const checkpoints: Array<{ revision: number } | undefined> = []
    const replication = replicateRxCollection<
      ProcessDocType,
      { revision: number }
    >({
      collection: current.process,
      replicationIdentifier,
      live: false,
      waitForLeadership: false,
      pull: {
        handler: async (checkpoint) => {
          checkpoints.push(checkpoint)
          return {
            documents: checkpoint ? [] : [doc("currently-authorized")],
            checkpoint: { revision: 2 },
          }
        },
      },
    })
    await replication.awaitInitialReplication()
    expect(checkpoints[0]).toBeUndefined()
    expect((await current.process.find().exec()).map((row) => row.id)).toEqual([
      "currently-authorized",
    ])
    await replication.cancel()
  } finally {
    await current.remove()
  }
})
