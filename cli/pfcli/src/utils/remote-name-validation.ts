import { Effect } from "effect"
import { CliError } from "../errors"
import { graphqlRequestWithCredentials } from "./graphql-client"

const LIST_PROJECT_STAGES_QUERY = `
  query ListProjectStages($projectId: String!) {
    listProjectStages(projectId: $projectId) {
      items {
        stageName
      }
    }
  }
`

const LIST_PROJECT_ENVIRONMENTS_QUERY = `
  query ListProjectEnvironments($projectId: String!) {
    listProjectEnvironments(projectId: $projectId) {
      items {
        environmentName
      }
    }
  }
`

const VALIDATION_LOOKUP_TIMEOUT_MS = 1_000
const INTERNAL_ENVIRONMENT_ID_PATTERN = /^env-[0-9A-HJKMNP-TV-Z]{26}$/

interface ListProjectStagesResponse {
  readonly listProjectStages: {
    readonly items: ReadonlyArray<{
      readonly stageName: string
    }>
  }
}

interface ListProjectEnvironmentsResponse {
  readonly listProjectEnvironments: {
    readonly items: ReadonlyArray<{
      readonly environmentName: string
    }>
  }
}

const isStageListResponse = (
  response: unknown,
): response is ListProjectStagesResponse =>
  typeof response === "object" &&
  response !== null &&
  "listProjectStages" in response &&
  Array.isArray(
    (response as ListProjectStagesResponse).listProjectStages?.items,
  )

const isEnvironmentListResponse = (
  response: unknown,
): response is ListProjectEnvironmentsResponse =>
  typeof response === "object" &&
  response !== null &&
  "listProjectEnvironments" in response &&
  Array.isArray(
    (response as ListProjectEnvironmentsResponse).listProjectEnvironments
      ?.items,
  )

const levenshteinDistance = (left: string, right: string): number => {
  if (left === right) {
    return 0
  }

  if (left.length === 0) {
    return right.length
  }

  if (right.length === 0) {
    return left.length
  }

  const previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  const current = new Array<number>(right.length + 1)

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    current[0] = leftIndex

    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitutionCost =
        left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1
      const deleteCost = (previous[rightIndex] ?? rightIndex) + 1
      const insertCost = (current[rightIndex - 1] ?? leftIndex) + 1
      const substituteCost =
        (previous[rightIndex - 1] ?? rightIndex - 1) + substitutionCost

      current[rightIndex] = Math.min(deleteCost, insertCost, substituteCost)
    }

    for (let rightIndex = 0; rightIndex <= right.length; rightIndex += 1) {
      previous[rightIndex] = current[rightIndex] ?? rightIndex
    }
  }

  return previous[right.length] ?? right.length
}

const getSuggestions = (
  value: string,
  knownValues: ReadonlyArray<string>,
):
  | { readonly kind: "none" }
  | { readonly kind: "single"; readonly value: string }
  | { readonly kind: "multiple"; readonly values: ReadonlyArray<string> } => {
  if (knownValues.length === 0) {
    return { kind: "none" }
  }

  const normalizedValue = value.toLowerCase()
  const scoredValues = knownValues
    .map((knownValue) => ({
      value: knownValue,
      score: levenshteinDistance(normalizedValue, knownValue.toLowerCase()),
    }))
    .sort((left, right) =>
      left.score === right.score
        ? left.value.localeCompare(right.value)
        : left.score - right.score,
    )

  const bestScore = scoredValues[0]?.score
  if (bestScore === undefined) {
    return { kind: "none" }
  }

  const bestValue = scoredValues[0]?.value
  if (bestValue === undefined) {
    return { kind: "none" }
  }

  const maxLength = Math.max(value.length, bestValue.length)
  const threshold = Math.max(1, Math.floor(maxLength / 3))
  if (bestScore > threshold) {
    return { kind: "none" }
  }

  const bestMatches = scoredValues
    .filter((item) => item.score === bestScore)
    .map((item) => item.value)

  if (bestMatches.length === 1) {
    const [firstMatch] = bestMatches
    if (firstMatch === undefined) {
      return { kind: "none" }
    }

    return { kind: "single", value: firstMatch }
  }

  return { kind: "multiple", values: bestMatches }
}

const buildUnknownNameMessage = (options: {
  readonly kind: "environment" | "stage"
  readonly projectId: string
  readonly value: string
  readonly knownValues: ReadonlyArray<string>
}) => {
  const suggestion = getSuggestions(options.value, options.knownValues)
  const lines = [
    `Unknown ${options.kind} "${options.value}" for project ${options.projectId}.`,
    "",
  ]

  if (suggestion.kind === "single") {
    lines.push(`Did you mean "${suggestion.value}"?`, "")
  } else if (suggestion.kind === "multiple") {
    lines.push(`Possible matches: ${suggestion.values.join(", ")}`, "")
  }

  lines.push(
    `Known ${options.kind}s:`,
    ...options.knownValues.map((knownValue) => `- ${knownValue}`),
  )

  return lines.join("\n")
}

const validateKnownName = (options: {
  readonly kind: "environment" | "stage"
  readonly projectId: string
  readonly value: string
  readonly knownValues: ReadonlyArray<string>
}): Effect.Effect<void, CliError> =>
  Effect.gen(function* () {
    if (options.knownValues.length === 0) {
      return
    }

    if (options.knownValues.includes(options.value)) {
      return
    }

    return yield* new CliError({
      message: buildUnknownNameMessage(options),
    })
  })

export const ensureKnownStageNames = (
  projectId: string,
  stageNames: ReadonlyArray<string>,
): Effect.Effect<void, CliError> =>
  Effect.gen(function* () {
    const response =
      yield* graphqlRequestWithCredentials<ListProjectStagesResponse>(
        LIST_PROJECT_STAGES_QUERY,
        { projectId },
        { timeoutMs: VALIDATION_LOOKUP_TIMEOUT_MS },
      ).pipe(Effect.catchTag("CliError", () => Effect.void))

    if (!response) {
      return
    }

    if (!isStageListResponse(response)) {
      return
    }

    const knownStageNames = response.listProjectStages.items.map(
      (item) => item.stageName,
    )

    for (const stageName of new Set(stageNames)) {
      yield* validateKnownName({
        kind: "stage",
        projectId,
        value: stageName,
        knownValues: knownStageNames,
      })
    }
  })

export const ensureKnownEnvironmentName = (
  projectId: string,
  environmentName: string,
): Effect.Effect<void, CliError> =>
  Effect.gen(function* () {
    if (INTERNAL_ENVIRONMENT_ID_PATTERN.test(environmentName)) {
      return
    }

    const response =
      yield* graphqlRequestWithCredentials<ListProjectEnvironmentsResponse>(
        LIST_PROJECT_ENVIRONMENTS_QUERY,
        { projectId },
        { timeoutMs: VALIDATION_LOOKUP_TIMEOUT_MS },
      ).pipe(Effect.catchTag("CliError", () => Effect.void))

    if (!response) {
      return
    }

    if (!isEnvironmentListResponse(response)) {
      return
    }

    const knownEnvironmentNames = response.listProjectEnvironments.items.map(
      (item) => item.environmentName,
    )

    yield* validateKnownName({
      kind: "environment",
      projectId,
      value: environmentName,
      knownValues: knownEnvironmentNames,
    })
  })
