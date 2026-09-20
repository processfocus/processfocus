/// <reference types="bun" />

import { Effect } from "effect"
import { scanAuthorizedPull } from "../src/lib/rxdb/utils"
import { describe, expect, it } from "bun:test"

type Row = { id: string; updatedAt: number; authorized: boolean }

const checkpointOf = (row: Row) => ({ id: row.id, updatedAt: row.updatedAt })

const makePull =
  (rows: Row[], checkpoints: Array<{ id: string; updatedAt: number } | null>) =>
  (checkpoint: { id: string; updatedAt: number } | null, limit: number) =>
    Effect.sync(() => {
      checkpoints.push(checkpoint)
      const start = checkpoint
        ? rows.findIndex(
            (row) =>
              row.updatedAt > checkpoint.updatedAt ||
              (row.updatedAt === checkpoint.updatedAt &&
                row.id > checkpoint.id),
          )
        : 0
      return start < 0 ? [] : rows.slice(start, start + limit)
    })

describe("scanAuthorizedPull", () => {
  it("advances from the last raw row and fills a mixed authorized page", async () => {
    const rows: Row[] = [
      { id: "01-denied", updatedAt: 1, authorized: false },
      { id: "02-allowed", updatedAt: 1, authorized: true },
      { id: "03-denied", updatedAt: 1, authorized: false },
      { id: "04-allowed", updatedAt: 1, authorized: true },
      { id: "05-allowed", updatedAt: 1, authorized: true },
    ]
    const checkpoints: Array<{ id: string; updatedAt: number } | null> = []

    const result = await Effect.runPromise(
      scanAuthorizedPull({
        initialCheckpoint: null,
        limit: 3,
        pull: makePull(rows, checkpoints),
        checkpointOf,
        authorizeRows: (page: Row[]) =>
          Effect.succeed(page.filter((row) => row.authorized)),
        idOfAuthorized: (row) => row.id,
      }),
    )

    expect(result.map((row) => row.id)).toEqual([
      "02-allowed",
      "04-allowed",
      "05-allowed",
    ])
    expect(checkpoints).toEqual([null, { id: "03-denied", updatedAt: 1 }])
  })

  it("scans beyond a fully unauthorized prefix until exhaustion", async () => {
    const rows: Row[] = [
      { id: "01-denied", updatedAt: 1, authorized: false },
      { id: "02-denied", updatedAt: 1, authorized: false },
      { id: "03-allowed", updatedAt: 1, authorized: true },
    ]
    const checkpoints: Array<{ id: string; updatedAt: number } | null> = []

    const result = await Effect.runPromise(
      scanAuthorizedPull({
        initialCheckpoint: null,
        limit: 2,
        pull: makePull(rows, checkpoints),
        checkpointOf,
        authorizeRows: (page: Row[]) =>
          Effect.succeed(page.filter((row) => row.authorized)),
        idOfAuthorized: (row) => row.id,
      }),
    )

    expect(result.map((row) => row.id)).toEqual(["03-allowed"])
    expect(checkpoints).toEqual([null, { id: "02-denied", updatedAt: 1 }])
  })

  it("does not return an updated document twice across raw pages", async () => {
    let pullCount = 0
    const result = await Effect.runPromise(
      scanAuthorizedPull({
        initialCheckpoint: null,
        limit: 2,
        pull: () =>
          Effect.sync(() => {
            pullCount += 1
            return pullCount === 1
              ? [
                  { id: "allowed-1", updatedAt: 1, authorized: true },
                  { id: "denied-1", updatedAt: 2, authorized: false },
                ]
              : [
                  { id: "allowed-1", updatedAt: 3, authorized: true },
                  { id: "allowed-2", updatedAt: 4, authorized: true },
                ]
          }),
        checkpointOf,
        authorizeRows: (page: Row[]) =>
          Effect.succeed(page.filter((row) => row.authorized)),
        idOfAuthorized: (row) => row.id,
      }),
    )

    expect(result).toEqual([
      { id: "allowed-1", updatedAt: 3, authorized: true },
      { id: "allowed-2", updatedAt: 4, authorized: true },
    ])
  })

  it("fails when a backend page repeats its checkpoint row", async () => {
    let pullCount = 0
    const repeated = { id: "02-denied", updatedAt: 1, authorized: false }
    const effect = scanAuthorizedPull({
      initialCheckpoint: null,
      limit: 2,
      pull: () =>
        Effect.sync(() => {
          pullCount += 1
          return pullCount === 1
            ? [{ id: "01-denied", updatedAt: 1, authorized: false }, repeated]
            : [repeated]
        }),
      checkpointOf,
      authorizeRows: (page: Row[]) =>
        Effect.succeed(page.filter((row) => row.authorized)),
      idOfAuthorized: (row) => row.id,
    })

    await expect(Effect.runPromise(effect)).rejects.toThrow(
      "Pull backend returned a non-advancing checkpoint page",
    )
  })
})
