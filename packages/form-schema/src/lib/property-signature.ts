import { Schema, type SchemaAST } from "effect"

/** Map field schemas while retaining Effect's property-level decoding contract. */
export const mapFormPropertySignature = (
  field: Schema.PropertySignature.All,
  map: (ast: SchemaAST.AST, side: "input" | "output") => SchemaAST.AST,
  mapAnnotations: (
    annotations: SchemaAST.Annotations,
    input: SchemaAST.AST,
    side: "input" | "output",
  ) => SchemaAST.Annotations = (annotations) => annotations,
): Schema.PropertySignature.All => {
  const signature = field.ast
  if (signature._tag === "PropertySignatureDeclaration")
    return Schema.makePropertySignature(
      new Schema.PropertySignatureDeclaration(
        map(signature.type, "input"),
        signature.isOptional,
        signature.isReadonly,
        mapAnnotations(signature.annotations, signature.type, "input"),
        signature.defaultValue,
      ),
    )
  const { from, to } = signature
  return Schema.makePropertySignature(
    new Schema.PropertySignatureTransformation(
      new Schema.FromPropertySignature(
        map(from.type, "input"),
        from.isOptional,
        from.isReadonly,
        mapAnnotations(from.annotations, from.type, "input"),
        from.fromKey,
      ),
      new Schema.ToPropertySignature(
        map(to.type, "output"),
        to.isOptional,
        to.isReadonly,
        mapAnnotations(to.annotations, from.type, "output"),
        to.defaultValue,
      ),
      signature.decode,
      signature.encode,
    ),
  )
}
