/**
 * Simplified implementation of the walker from the form package. Much more
 * complicated than we really need for our test, but having something
 * very similar allowed for better verification that we can create real forms.
 */

import { Context, Data, Effect, Layer, Match, type Schema } from "effect"
import * as AST from "effect/SchemaAST"
import { hasStructuralOnlyAnnotation } from "./annotation-helpers"
import { STRUCTURAL_TYPE_SYMBOL } from "./form-schema"

type Form = Record<string, Element>
type Element = string | { fieldset: Form }

export const isFieldset = (element: Element): element is { fieldset: Form } => {
  return typeof element === "object" && "fieldset" in element
}

class FormService extends Context.Service<
  FormService,
  {
    readonly form: (
      ast: AST.AST,
    ) => Effect.Effect<
      Form,
      | UnknownSchemaFieldTypeError
      | IndexSignaturesNotSupportedError
      | UnrecognizedASTNodeError,
      FieldComponent
    >
  }
>()("@pf/form-schema/FormService") {}

class FieldComponent extends Context.Service<
  FieldComponent,
  {
    readonly component: (
      prop: AST.PropertySignature,
      parentPath: string,
    ) => Effect.Effect<
      Element,
      | UnknownSchemaFieldTypeError
      | IndexSignaturesNotSupportedError
      | UnrecognizedASTNodeError,
      FieldComponent
    >
  }
>()("@pf/form-schema/FieldComponent") {}

const FormServiceTest = Layer.succeed(FormService, {
  form: (ast: AST.AST) => walkAST(ast),
})

/**
 * Navigate Effect Schema AST, and emit dummy form structure.
 */
const walkAST = (ast: AST.AST, parentPath = "") =>
  Effect.gen(function* () {
    const fields = yield* Match.type<AST.AST>().pipe(
      Match.tag("Objects", (typeLiteral) =>
        Effect.gen(function* () {
          const fields: Form = {}

          const f = yield* FieldComponent
          for (const prop of typeLiteral.propertySignatures) {
            const fieldName = String(prop.name)
            const field = yield* f.component(prop, parentPath)
            fields[fieldName] = field
          }

          // Index signatures are for things like `[x: string]: string`
          // We do not support them (these would be random fields in our input)
          if (typeLiteral.indexSignatures.length) {
            return yield* new IndexSignaturesNotSupportedError()
          }

          return fields
        }),
      ),
      Match.orElse((node) =>
        Effect.fail(new UnrecognizedASTNodeError({ nodeTag: node._tag })),
      ),
    )(ast)

    return fields
  })

/**
 * Effect which emits form components.
 */
export const emitFields = (ast: AST.AST) =>
  Effect.gen(function* () {
    const builder = yield* FormService
    const components = yield* builder.form(ast)
    return components
  })

class UnknownSchemaFieldTypeError extends Data.TaggedError(
  "UnknownSchemaFieldTypeError",
)<{
  readonly fieldName: string
  readonly schemaType: string
}> {
  override get message() {
    return `Cannot create form field "${this.fieldName}": schema type "${this.schemaType}" is not supported`
  }
}

class IndexSignaturesNotSupportedError extends Data.TaggedError(
  "IndexSignaturesNotSupportedError",
  // biome-ignore lint/complexity/noBannedTypes: Effect TaggedError pattern
)<{}> {
  override get message() {
    return "Index signatures are not supported in schemas"
  }
}

class UnrecognizedASTNodeError extends Data.TaggedError(
  "UnrecognizedASTNodeError",
)<{
  readonly nodeTag: string
}> {
  override get message() {
    return `AST node type "${this.nodeTag}" is not recognized`
  }
}

const FieldComponentTest = Layer.succeed(FieldComponent, {
  component: (prop: AST.PropertySignature, parentPath: string) =>
    tagToField(prop, parentPath),
})

/**
 * Creates a component based on Schema tag.
 *
 */
const tagToField = (
  prop: AST.PropertySignature,
  parentPath: string,
): Effect.Effect<
  Element,
  | UnknownSchemaFieldTypeError
  | IndexSignaturesNotSupportedError
  | UnrecognizedASTNodeError,
  FieldComponent
> => {
  const fieldName = String(prop.name)
  const name = parentPath ? `${parentPath}.${fieldName}` : fieldName

  const appField = (name: string) => Effect.succeed(name)

  const match = Match.type<AST.AST>().pipe(
    Match.tag("String", () => appField("textfield")),
    Match.tag("Boolean", () => appField("checkbox")),
    Match.tag("Number", () => appField("numberfield")),
    Match.tag("Objects", () =>
      Effect.gen(function* () {
        const fields = yield* walkAST(prop.type, name)
        return { fieldset: fields }
      }),
    ),
    Match.tag("Undefined", () => {
      // Check if this is a structural-only element
      const fieldAsSchema = { ast: prop.type } as Schema.Top
      if (hasStructuralOnlyAnnotation(fieldAsSchema)) {
        // Extract the structural type from annotations
        const value = Reflect.get(
          AST.resolve(prop.type) ?? {},
          STRUCTURAL_TYPE_SYMBOL,
        )
        const structuralType = typeof value === "string" ? value : "structural"
        return appField(structuralType)
      }
      // Regular undefined field - not supported
      return Effect.fail(
        new UnknownSchemaFieldTypeError({
          fieldName: String(prop.name),
          schemaType: prop.type._tag,
        }),
      )
    }),
    Match.orElse(() =>
      Effect.fail(
        new UnknownSchemaFieldTypeError({
          fieldName: String(prop.name),
          schemaType: prop.type._tag,
        }),
      ),
    ),
  )
  return match(prop.type)
}

// Merged layer for form components (constant, created once)
export const mergedComponentLayer = Layer.merge(
  FormServiceTest,
  FieldComponentTest,
)
