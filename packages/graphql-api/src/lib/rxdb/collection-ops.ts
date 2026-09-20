import type { Effect } from "effect"
import type { PullCheckpoint, UserDetails } from "@pf/graphql-db-operations"
import type { RxDbDocument } from "@pf/graphql-schema"
import type { RequestTime } from "@pf/request-time"

/**
 * Input for a push row in RxDB replication.
 * Contains the assumed master state (for conflict detection) and new document state.
 */
export interface RxDbPushRowInput<T> {
  assumedMasterState?: T | null
  newDocumentState: T & { deleted: boolean }
}

/**
 * Result of a push operation.
 * Contains successfully written documents and any conflicts.
 */
export interface PushResult<GraphQL> {
  conflicts: Array<GraphQL>
  successful: Array<GraphQL>
}

/**
 * Generic interface for RxDB collection operations.
 *
 * Each collection must implement this interface to use the generic resolvers.
 * The interface separates database operations from GraphQL mapping, allowing
 * reuse of resolver logic across different collections.
 *
 * @typeParam Row - Database row type
 * @typeParam GraphQL - GraphQL document type (must extend RxDbDocument)
 * @typeParam InsertInput - Input type for insert operations
 * @typeParam MapContext - Context required by mapToGraphql (defaults to never)
 */
export interface RxDbCollectionOps<
  Row,
  GraphQL extends RxDbDocument,
  InsertInput extends RxDbDocument,
  MapContext = never,
> {
  /**
   * Pull documents from the database for RxDB replication.
   * Must return documents ordered by (updatedAt, id) for correct checkpoint calculation.
   *
   * @param checkpoint - Resume from this checkpoint, or null for initial sync
   * @param limit - Maximum number of documents to return
   */
  readonly pull: (
    checkpoint: PullCheckpoint | null | undefined,
    limit: number,
  ) => Effect.Effect<Row[], Error, UserDetails>

  /**
   * Insert a new document.
   *
   * @param id - Client-supplied document ID
   * @param input - Document data to insert
   * @returns The document ID on success
   */
  readonly insert: (
    id: string,
    input: InsertInput,
  ) => Effect.Effect<string, Error, RequestTime | UserDetails>

  /**
   * Update an existing document.
   *
   * @param id - Document ID to update
   * @param input - New document data
   * @returns The document ID on success
   */
  readonly update: (
    id: string,
    input: InsertInput,
    assumedMasterState: InsertInput,
  ) => Effect.Effect<string, Error, RequestTime | UserDetails>

  /**
   * Soft-delete a document (set deleted flag).
   *
   * @param id - Document ID to delete
   * @returns The document ID on success
   */
  readonly delete: (
    id: string,
    assumedMasterState: InsertInput,
  ) => Effect.Effect<string, Error, RequestTime | UserDetails>

  /**
   * Get documents by their IDs.
   * Used to fetch current state for conflict detection and return values.
   *
   * @param ids - Document IDs to fetch
   */
  readonly getByIds: (ids: string[]) => Effect.Effect<Row[], Error, UserDetails>

  /**
   * Map a database row to GraphQL document type.
   * This is where you add computed fields, format conversions, etc.
   * Returns an Effect to support async transformations (e.g., schema validation).
   */
  readonly mapToGraphql: (row: Row) => Effect.Effect<GraphQL, never, MapContext>
}
