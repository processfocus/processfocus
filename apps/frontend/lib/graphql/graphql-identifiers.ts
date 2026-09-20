const GRAPHQL_IDENTIFIER_PATTERN = /^[_A-Za-z][_0-9A-Za-z]*$/

export const isGraphqlIdentifier = (value: string): boolean =>
  GRAPHQL_IDENTIFIER_PATTERN.test(value)

export function assertGraphqlIdentifier(value: string, label: string): void {
  if (!isGraphqlIdentifier(value)) {
    throw new Error(`${label} must be a valid GraphQL identifier.`)
  }
}
