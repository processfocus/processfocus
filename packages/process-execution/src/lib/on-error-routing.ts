import type { FlowWithCondition } from "@pf/graphql-db-operations"

export const selectMatchingOnErrorFlows = (
  flows: readonly FlowWithCondition[],
  errorTag: string | undefined,
): readonly FlowWithCondition[] => {
  const onErrorFlows = flows.filter((flow) => flow.isOnError)
  if (onErrorFlows.length === 0) {
    return []
  }

  const taggedMatches = errorTag
    ? onErrorFlows.filter((flow) => flow.taggedErrors?.includes(errorTag))
    : []
  if (taggedMatches.length > 0) {
    return taggedMatches
  }

  return onErrorFlows.filter(
    (flow) => flow.taggedErrors === null || flow.taggedErrors.length === 0,
  )
}

export const hasMatchingOnErrorFlow = (
  flows: readonly FlowWithCondition[],
  errorTag: string | undefined,
): boolean => selectMatchingOnErrorFlows(flows, errorTag).length > 0
