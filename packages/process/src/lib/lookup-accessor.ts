import type { Effect, Schema } from "effect"
import type { LookupItem } from "@pf/form-schema"

/**
 * Input for independent lookup queries — just filter.
 */
export type QueryInput = { readonly filter: string }

/**
 * Extracts the field name literal from a LookupAccessor.
 */
type ExtractFieldName<T> =
  // biome-ignore lint/suspicious/noExplicitAny: type-level extraction
  T extends LookupAccessor<any, infer K> ? K : never

/**
 * Input for dependent lookup queries — filter + required dep values.
 */
// biome-ignore lint/suspicious/noExplicitAny: type-level extraction
export type DependentQueryInput<D extends LookupAccessor<any, any>[]> = {
  readonly filter: string
} & { readonly [F in ExtractFieldName<D[number]>]: string }

/**
 * Internal override stored by LookupAccessor/LookupBuilder.
 */
export interface LookupOverride {
  readonly query: (
    input: Record<string, string>,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<LookupItem>, unknown, unknown>
  readonly dependencies?: ReadonlyArray<string>
}

/**
 * Storage interface so accessors can write back without depending on Form.
 */
export interface LookupOverrideStore {
  _setLookupOverride(fieldName: string, override: LookupOverride): void
}

/**
 * Typed accessor for a single lookup field on a Form.
 *
 * Call `.setQuery()` for independent lookups, or
 * `.dependsOn([...]).setQuery()` for dependent lookups.
 */
export class LookupAccessor<
  TInput extends Schema.Struct.Fields,
  K extends string,
> {
  readonly fieldName: K
  private _store: LookupOverrideStore

  constructor(store: LookupOverrideStore, fieldName: K) {
    this._store = store
    this.fieldName = fieldName
  }

  /**
   * Set the query for an independent lookup (no dependencies).
   */
  setQuery(
    query: (
      input: QueryInput,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<LookupItem>, unknown, unknown>,
  ): void {
    this._store._setLookupOverride(this.fieldName, {
      query: query as LookupOverride["query"],
    })
  }

  /**
   * Declare dependencies on other lookup fields, returning a builder
   * whose `setQuery` receives the dependency values as typed input.
   */
  dependsOn<
    const D extends LookupAccessor<TInput, Exclude<keyof TInput & string, K>>[],
  >(deps: [...D]): LookupBuilder<TInput, K, D> {
    return new LookupBuilder(this._store, this.fieldName, deps)
  }
}

/**
 * Builder returned by `LookupAccessor.dependsOn()`.
 * Its `setQuery` callback receives `{ filter, ...depValues }`.
 */
export class LookupBuilder<
  _TInput extends Schema.Struct.Fields,
  K extends string,
  // biome-ignore lint/suspicious/noExplicitAny: type-level extraction
  D extends LookupAccessor<any, any>[],
> {
  private _store: LookupOverrideStore
  private _fieldName: K
  private _deps: D

  constructor(store: LookupOverrideStore, fieldName: K, deps: D) {
    this._store = store
    this._fieldName = fieldName
    this._deps = deps
  }

  /**
   * Set the query for this dependent lookup.
   */
  setQuery(
    query: (
      input: DependentQueryInput<D>,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<LookupItem>, unknown, unknown>,
  ): void {
    this._store._setLookupOverride(this._fieldName, {
      query: query as LookupOverride["query"],
      dependencies: this._deps.map((d) => d.fieldName),
    })
  }
}
