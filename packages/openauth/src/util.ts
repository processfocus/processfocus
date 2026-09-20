export type Prettify<T> = {
  [K in keyof T]: T[K]
}

export function lazy<T>(fn: () => T): () => T {
  let value: T | undefined
  return () => {
    if (value === undefined) {
      value = fn()
    }
    return value
  }
}
