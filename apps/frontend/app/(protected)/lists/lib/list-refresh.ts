import type {
  ListDataResult,
  ListQueryVariables,
} from "@/lib/graphql/list-queries"

type RefreshResult =
  | { readonly kind: "loading" }
  | { readonly kind: "error" }
  | { readonly kind: "ready"; readonly data: ListDataResult }

type RefreshEntry = {
  version: number
  sources: ReadonlySet<ListDataResult>
  result: RefreshResult
}

type ListRefreshSnapshot = {
  readonly versions: ReadonlyMap<string, number>
  readonly results: ReadonlyMap<string, RefreshEntry>
}

/** Owned by one authenticated shell, never persisted across logout/reload. */
export class ListRefreshState {
  private versions = new Map<string, number>()
  private results = new Map<string, RefreshEntry>()
  private returns = new Map<string, string>()
  private listeners = new Set<() => void>()
  private current: ListRefreshSnapshot = {
    versions: new Map(),
    results: new Map(),
  }
  private initial = this.current

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  snapshot = () => this.current
  serverSnapshot = () => this.initial
  private emit() {
    this.current = {
      versions: new Map(this.versions),
      results: new Map(this.results),
    }
    for (const listener of this.listeners) listener()
  }

  rememberReturn(destination: string): string {
    const token = crypto.randomUUID()
    this.returns.set(token, destination)
    return token
  }

  canReturn(token: string | null, destination: string): boolean {
    return token !== null && this.returns.get(token) === destination
  }

  invalidate(path: string): void {
    this.versions.set(path, (this.versions.get(path) ?? 0) + 1)
    this.emit()
  }

  private key(path: string, variables: ListQueryVariables): string {
    return JSON.stringify([
      path,
      variables.page,
      variables.limit,
      variables.filter,
      variables.sort ?? null,
    ])
  }

  read(
    path: string,
    variables: ListQueryVariables,
    initial: ListDataResult,
    snapshot = this.current,
  ): RefreshResult {
    const version = snapshot.versions.get(path) ?? 0
    if (version === 0) return { kind: "ready", data: initial }
    const entry = snapshot.results.get(this.key(path, variables))
    return entry?.version === version && entry.sources.has(initial)
      ? entry.result
      : { kind: "loading" }
  }

  async refresh(
    path: string,
    variables: ListQueryVariables,
    initial: ListDataResult,
    fetch: (variables: ListQueryVariables) => Promise<ListDataResult>,
    snapshot = this.current,
  ): Promise<void> {
    const version = snapshot.versions.get(path) ?? 0
    if ((this.versions.get(path) ?? 0) !== version) return
    const key = this.key(path, variables)
    const previous = this.results.get(key)
    if (previous?.version === version && previous.sources.has(initial)) return
    const sources = new Set(previous?.sources)
    sources.add(initial)
    const pending: RefreshEntry = {
      version,
      sources,
      result: { kind: "loading" },
    }
    if (version === 0) {
      this.results.set(key, {
        ...pending,
        result: { kind: "ready", data: initial },
      })
      this.emit()
      return
    }
    // A new RSC payload can follow a write outside this List. Revalidate it
    // rather than masking it with cached rows or trusting an older prefetch.
    // Previously seen payloads (Back/Forward) keep the latest refreshed rows.
    this.results.set(key, pending)
    this.emit()
    try {
      const data = await fetch(variables)
      if (
        this.versions.get(path) !== version ||
        this.results.get(key) !== pending
      )
        return
      this.results.set(key, {
        version,
        sources,
        result: { kind: "ready", data },
      })
      if (data.page !== variables.page) {
        this.results.set(this.key(path, { ...variables, page: data.page }), {
          version,
          sources,
          result: { kind: "ready", data },
        })
      }
    } catch {
      if (
        this.versions.get(path) !== version ||
        this.results.get(key) !== pending
      )
        return
      this.results.set(key, { version, sources, result: { kind: "error" } })
    }
    this.emit()
  }
}

/** Parse untrusted return URLs before navigating or invalidating List state. */
export function parseListReturnDestination(
  returnTo: string | null,
  origin: string,
) {
  if (!returnTo?.startsWith("/lists/")) return null
  try {
    const destination = new URL(returnTo, origin)
    if (
      destination.origin !== origin ||
      !destination.pathname.startsWith("/lists/")
    )
      return null
    return {
      href: `${destination.pathname}${destination.search}`,
      listPath: decodeURIComponent(destination.pathname).slice("/lists".length),
    }
  } catch {
    return null
  }
}
