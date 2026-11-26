import { Schema, type SchemaAST } from "effect"
import {
  METRIC_BREAKDOWN_SYMBOL,
  fieldAnnotation,
  hasFlattenAnnotation,
  hasStructuralOnlyAnnotation,
  isMetricBreakdownOptions,
} from "@pf/form-schema"

// List detail GraphQL types are derived from the form, not the table columns.
// Keep read-only fields: they are output data even though they are not submitted.
// Flatten wrappers are visual-only containers, so their children are selected
// inline to match the flattened output type and the flat query result.
export const listDetailSelection = (schema: Schema.Top): string => {
  const selection = (ast: SchemaAST.AST): string => {
    // Annotation-backed item data has an output shape independent of its AST.
    // Match the metric output contract in walkOutputAST, including structural
    // metric elements that opt into item-backed data.
    const metric = fieldAnnotation(ast, METRIC_BREAKDOWN_SYMBOL)
    if (isMetricBreakdownOptions(metric) && metric.dataSource === "item") {
      return "total currency badge fields { label value } buckets { label amount description color }"
    }
    if (hasStructuralOnlyAnnotation(Schema.make(ast))) return ""
    switch (ast._tag) {
      case "Objects":
        return ast.propertySignatures
          .map((property) => {
            const children = selection(property.type)
            if (
              !children &&
              hasStructuralOnlyAnnotation(Schema.make(property.type))
            )
              return ""
            if (
              property.type._tag === "Objects" &&
              hasFlattenAnnotation(Schema.make(property.type))
            ) {
              return children
            }
            const name = String(property.name)
            return children ? `${name} { ${children} }` : name
          })
          .filter((field) => field.length > 0)
          .join("\n")
      case "Union":
        return ast.types.map(selection).find(Boolean) ?? ""
      case "Arrays":
        return ast.rest.map(selection).find(Boolean) ?? ""
      default:
        return ""
    }
  }
  return selection(schema.ast)
}
