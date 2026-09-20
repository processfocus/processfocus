import type { LookupSuggestion } from "@pf/form/lookup-context"
import { assertGraphqlIdentifier } from "./graphql-identifiers"

interface GraphqlRequester {
  request<TResponse>(
    document: string,
    variables?: Record<string, unknown>,
  ): Promise<TResponse>
}

const reservedInputKeys = new Set(["limit"])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

function buildDependentLookupQuery(
  queryName: string,
  inputFields: string,
  inputPassthrough: string,
): string {
  return [
    `query DependentLookup(${inputFields}, $limit: Int) {`,
    `  ${queryName}(input: { ${inputPassthrough} }, limit: $limit) {`,
    "    value",
    "    label",
    "  }",
    "}",
  ].join("\n")
}

/**
 * Fetches suggestions from a generated dependent lookup query.
 * `variables.input` must be a non-empty object; callers normally include
 * `filter` plus any dependency fields. Top-level `variables.limit` is optional.
 */
export async function fetchDependentLookupSuggestions(
  graphqlClient: GraphqlRequester,
  queryName: string,
  variables: Record<string, unknown>,
): Promise<LookupSuggestion[]> {
  assertGraphqlIdentifier(queryName, "Dependent lookup query name")
  const inputObj = variables["input"]
  if (!isRecord(inputObj) || Object.keys(inputObj).length === 0) {
    throw new Error("Dependent lookup input must include at least one field.")
  }
  const inputKeys = Object.keys(inputObj)
  for (const key of inputKeys) {
    assertGraphqlIdentifier(key, "Dependent lookup input key")
    if (reservedInputKeys.has(key)) {
      throw new Error(`Dependent lookup input key "${key}" is reserved.`)
    }
  }

  // The form caller supplies a non-empty input object that includes filter.
  const inputFields = inputKeys
    .map((key) => (key === "filter" ? "$filter: String" : `$${key}: String!`))
    .join(", ")
  const inputPassthrough = inputKeys.map((key) => `${key}: $${key}`).join(", ")
  const query = buildDependentLookupQuery(
    queryName,
    inputFields,
    inputPassthrough,
  )

  const flatVars: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(inputObj)) {
    flatVars[key] = value
  }
  if (variables["limit"] !== undefined) {
    flatVars["limit"] = variables["limit"]
  }

  const data = await graphqlClient.request<Record<string, unknown>>(
    query,
    flatVars,
  )
  return (data[queryName] ?? []) as LookupSuggestion[]
}
