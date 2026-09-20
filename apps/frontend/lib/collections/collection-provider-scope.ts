import type { CollectionStateStatus } from "./collection-provider-factory"

export const shouldResetCollectionScope = (
  activeScopeKey: string | null,
  nextScopeKey: string,
): boolean => activeScopeKey !== null && activeScopeKey !== nextScopeKey

export const shouldResetCollectionBinding = ({
  activeCollection,
  activeScopeKey,
  nextCollection,
  nextScopeKey,
}: {
  activeCollection: unknown | null
  activeScopeKey: string | null
  nextCollection: unknown | null
  nextScopeKey: string
}): boolean => {
  if (shouldResetCollectionScope(activeScopeKey, nextScopeKey)) {
    return true
  }

  return (
    activeScopeKey !== null &&
    activeScopeKey === nextScopeKey &&
    activeCollection !== null &&
    nextCollection !== null &&
    activeCollection !== nextCollection
  )
}

export const canInitializeCollectionForScope = ({
  activeScopeKey,
  initializationInProgress,
  nextScopeKey,
  persistentStatus,
}: {
  activeScopeKey: string | null
  initializationInProgress: boolean
  nextScopeKey: string
  persistentStatus: CollectionStateStatus
}): boolean => {
  if (initializationInProgress || persistentStatus !== "waiting-for-rxdb") {
    return false
  }

  return activeScopeKey === null || activeScopeKey === nextScopeKey
}
