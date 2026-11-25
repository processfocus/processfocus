import { createHash } from "node:crypto"
import { Effect } from "effect"
import type {
  DelegationPrincipal,
  ProviderUserPrincipal,
  ServiceAccountPrincipal,
} from "@pf/auth-policy"
import type { Session } from "@pf/auth-session"
import { getSessionCacheScope } from "@pf/auth-session/session-cache-scope"
import {
  ProcessCollectionQueries,
  type ProcessCollectionRow,
  type ProcessMetadataRow,
  type PullCheckpoint,
} from "@pf/graphql-db-operations"
import { NoProviderUserID } from "@pf/graphql-schema"
import {
  buildStepPrincipal,
  filterProcessRowsForPrincipal,
} from "../authorization"
import type { UserContext } from "../types"

type ProcessPrincipal =
  | ProviderUserPrincipal
  | DelegationPrincipal
  | ServiceAccountPrincipal

export type ProcessReplicationPrincipal = ProcessPrincipal & {
  readonly processReplicationScope: string
}

// Scope includes the same verified identity, selected roles, delegation generation
// and role selection as the client cache. Organisation isolation is the database.
export const withProcessReplicationScope = (
  principal: ProcessPrincipal,
  session: Session,
): ProcessReplicationPrincipal => ({
  ...principal,
  processReplicationScope: createHash("sha256")
    .update(getSessionCacheScope(session))
    .digest("hex"),
})

export const buildProcessReplicationPrincipal = (context: UserContext) =>
  Effect.gen(function* () {
    const principal = yield* buildStepPrincipal(context)
    const session = context.jwt?.properties
    if (!session)
      return yield* new NoProviderUserID({
        message: "Replication requires an authenticated session",
      })
    return withProcessReplicationScope(principal, session)
  })

/** History permits only this schema-compatible marker, never current content. */
const removal = (row: ProcessMetadataRow): ProcessCollectionRow => ({
  id: row.id,
  updatedAt: row.updatedAt,
  deleted: true,
  name: "",
  path: "",
  purpose: "",
  startStepPath: "",
  orgUnit: { id: "", name: "", orgUnitLevel: "" },
  activeInstances: 0,
  formFieldCount: 0,
  minDurationMs: null,
  maxDurationMs: null,
})

/** Called inside the caller's transaction, shared by pull and live delivery. */
export const replicatedProcessRows = <T extends ProcessMetadataRow>(
  principal: ProcessReplicationPrincipal,
  rows: readonly T[],
) =>
  Effect.gen(function* () {
    const queries = yield* ProcessCollectionQueries
    const scope = principal.processReplicationScope
    const authorized = yield* filterProcessRowsForPrincipal(
      principal,
      rows.filter((row) => !row.deleted),
    )
    const liveIds = new Set(authorized.map((row) => row.id))
    const observed = new Set(
      yield* queries.getObservedProcessIds(
        scope,
        rows.map((row) => row.id),
      ),
    )
    yield* queries.observeProcesses(scope, [...liveIds])
    return rows.flatMap<T | ProcessCollectionRow>((row) =>
      liveIds.has(row.id) ? [row] : observed.has(row.id) ? [removal(row)] : [],
    )
  })

/** Advance past filtered pages too, so a denied tail is not rescanned forever. */
export const pullReplicatedProcesses = (
  principal: ProcessReplicationPrincipal,
  initialCheckpoint: PullCheckpoint | null,
  limit: number,
) =>
  Effect.gen(function* () {
    const queries = yield* ProcessCollectionQueries
    let checkpoint = initialCheckpoint
    const rows: ProcessCollectionRow[] = []
    while (rows.length < limit) {
      const page = yield* queries.pullProcess(checkpoint, limit - rows.length)
      const last = page[page.length - 1]
      if (!last) break
      rows.push(...(yield* replicatedProcessRows(principal, page)))
      checkpoint = { id: last.id, updatedAt: last.updatedAt }
    }
    return { rows, checkpoint }
  })
