import type * as AST from "effect/SchemaAST"

export const isNotNullLiteral = (ast: AST.AST): boolean =>
  !(ast._tag === "Literal" && ast.literal === null)

export const mapLiteralToGraphQLType = (
  literal: AST.LiteralValue,
): string | undefined => {
  switch (typeof literal) {
    case "string":
      return "String"
    case "number":
      return "Float"
    case "boolean":
      return "Boolean"
    default:
      return undefined
  }
}

export const literalUnionGraphQLType = (
  types: readonly AST.AST[],
): string | undefined => {
  const graphQLTypes = types.map((member) =>
    member._tag === "Literal"
      ? mapLiteralToGraphQLType(member.literal)
      : undefined,
  )
  const first = graphQLTypes[0]
  return first !== undefined && graphQLTypes.every((type) => type === first)
    ? first
    : undefined
}
