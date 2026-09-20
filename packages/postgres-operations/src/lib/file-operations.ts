import { and, eq, sql } from "drizzle-orm"
import { Effect, Layer } from "effect"
import * as schema from "@pf/drizzle-postgres"
import { FileOperations, returnedRow } from "@pf/graphql-db-operations"
import { getRequestTime } from "@pf/request-time"
import { TypedPostgresDrizzle } from "@pf/service-drizzle-postgres"

/**
 * PostgreSQL implementation of the FileOperations service.
 * Provides file tracking operations using Drizzle ORM against PostgreSQL.
 */
export const PostgresFileOperationsLive = Layer.effect(
  FileOperations,
  Effect.gen(function* () {
    const db = yield* TypedPostgresDrizzle

    return {
      createFile: (documentStoreId, mimeType, createdBy) =>
        Effect.gen(function* () {
          const requestTime = yield* getRequestTime()

          const result = yield* db
            .insert(schema.file)
            .values({
              documentStoreId,
              mediaKind: mimeType ?? null,
              uploadPending: true,
              createdBy,
              createdAt: requestTime,
              updatedAt: requestTime,
            })
            .returning({ id: schema.file.id })

          return (yield* returnedRow(result)).id
        }),

      getFileWithStore: (fileId) =>
        Effect.gen(function* () {
          const rows = yield* db
            .select({
              id: schema.file.id,
              documentStoreId: schema.file.documentStoreId,
              fileSize: schema.file.fileSize,
              uploadPending: schema.file.uploadPending,
              storeName: schema.documentStore.name,
              acceptedTypes: schema.documentStore.acceptedTypes,
              sizeLimit: schema.documentStore.sizeLimit,
            })
            .from(schema.file)
            .innerJoin(
              schema.documentStore,
              eq(schema.file.documentStoreId, schema.documentStore.id),
            )
            .where(eq(schema.file.id, fileId))
            .limit(1)

          const row = rows[0]
          if (!row) return null
          return {
            ...row,
            acceptedTypes: (row.acceptedTypes as string[] | null) ?? null,
          }
        }),

      markFileUploaded: (fileId, fileSize, mimeType) =>
        Effect.gen(function* () {
          const requestTime = yield* getRequestTime()

          // Build update set conditionally - Drizzle ignores undefined values
          const updateSet: Record<string, unknown> = {
            uploadPending: false,
            updatedAt: requestTime,
          }

          if (fileSize !== undefined) {
            updateSet["fileSize"] = fileSize
          }
          if (mimeType !== undefined) {
            updateSet["mediaKind"] = mimeType
          }

          yield* db
            .update(schema.file)
            .set(updateSet)
            .where(eq(schema.file.id, fileId))
        }),

      getDocumentStoreByPath: (path) =>
        Effect.gen(function* () {
          const rows = yield* db
            .select({
              id: schema.documentStore.id,
              name: schema.documentStore.name,
            })
            .from(schema.documentStore)
            .where(eq(schema.documentStore.path, path))
            .limit(1)

          return rows[0] ?? null
        }),

      isStepLinkedToDocumentStore: (stepPath, documentStorePath) =>
        Effect.gen(function* () {
          const rows = yield* db
            .select({ count: sql<number>`count(*)` })
            .from(schema.stepDocumentStore)
            .innerJoin(
              schema.step,
              eq(schema.stepDocumentStore.stepId, schema.step.id),
            )
            .innerJoin(
              schema.documentStore,
              eq(
                schema.stepDocumentStore.documentStoreId,
                schema.documentStore.id,
              ),
            )
            .where(
              and(
                eq(schema.step.path, stepPath),
                eq(schema.documentStore.path, documentStorePath),
                eq(schema.stepDocumentStore._deleted, false),
              ),
            )
            .limit(1)

          return (rows[0]?.count ?? 0) > 0
        }),

      getFileOwnerInfo: (fileId) =>
        Effect.gen(function* () {
          const rows = yield* db
            .select({
              createdBy: schema.file.createdBy,
              orgUnitPath: schema.orgUnit.path,
              documentStorePath: schema.documentStore.path,
            })
            .from(schema.file)
            .innerJoin(
              schema.documentStore,
              eq(schema.file.documentStoreId, schema.documentStore.id),
            )
            .innerJoin(
              schema.orgUnit,
              eq(schema.documentStore.orgUnitId, schema.orgUnit.id),
            )
            .where(eq(schema.file.id, fileId))
            .limit(1)

          const row = rows[0]
          if (!row?.createdBy) return null
          return {
            createdBy: row.createdBy,
            orgUnitPath: row.orgUnitPath,
            documentStorePath: row.documentStorePath,
          }
        }),

      deleteFile: (fileId) =>
        Effect.gen(function* () {
          const result = yield* db
            .delete(schema.file)
            .where(eq(schema.file.id, fileId))
            .returning({ id: schema.file.id })
          return result.length > 0
        }),
    }
  }),
)
