/** An opaque authoring-time value. Only the owning Form can resolve it. */
export const DeferredValueTypeId = Symbol.for("pf/form/deferred-value")

export interface DeferredValue<out Value> {
  readonly [DeferredValueTypeId]: true
  readonly fallback: Value | undefined
}

export type FormValue<Value> = Value | DeferredValue<Value | undefined>

export const isDeferredValue = (
  value: unknown,
): value is DeferredValue<unknown> =>
  typeof value === "object" &&
  value !== null &&
  DeferredValueTypeId in value &&
  value[DeferredValueTypeId] === true &&
  "fallback" in value

/** Internal annotation for a deferred structural leaf, never a value schema. */
export const FormDeferredContent = Symbol.for("pf/form/deferred-content")
