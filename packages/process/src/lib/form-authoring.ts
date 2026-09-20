import { Schema, SchemaAST } from "effect"
import {
  type DeferredValue,
  DeferredValueTypeId,
  FormAutoComplete,
  FormCalendarSlotInput,
  FormDefault,
  FormDeferredContent,
  FormDescription,
  FormLabel,
  FormLookupInput,
  STRUCTURAL_ONLY_SYMBOL,
  type StructuralOnlyMarker,
  TextBlock,
  isDeferredValue,
} from "@pf/form-schema"
import type { FlowContext, FormStepMeta, StepMeta } from "./flow-context"
import {
  FormDecorationError,
  decorateAst,
  mapFormFields,
} from "./form-decoration"

type StructuralContent = Schema.Schema.Any & StructuralOnlyMarker
type Resolver<
  State,
  Steps extends Record<string, StepMeta | FormStepMeta>,
  Item,
  A,
> = (state: State, ctx: FlowContext<Steps>, item: Item) => A

export interface FormAuthoring<
  State,
  Steps extends Record<string, StepMeta | FormStepMeta>,
  Item,
> {
  readonly value: <A>(
    resolve: Resolver<State, Steps, Item, A>,
    fallback?: NoInfer<A>,
  ) => DeferredValue<A>
  readonly query: <A>(
    resolve: Resolver<State, Steps, Item, A>,
  ) => DeferredValue<A>
  readonly content: (
    resolve: Resolver<State, Steps, Item, StructuralContent | undefined>,
    fallback?: StructuralContent,
  ) => StructuralContent
}

const fail = (path: string, message: string): never => {
  throw new FormDecorationError({ path, message: `${path}: ${message}` })
}

const structuralAst = (content: unknown, path: string): SchemaAST.AST => {
  if (
    !Schema.isSchema(content) ||
    content.ast._tag !== "UndefinedKeyword" ||
    content.ast.annotations[STRUCTURAL_ONLY_SYMBOL] !== true ||
    content.ast.annotations[FormDeferredContent] !== undefined
  )
    return fail(
      path,
      "content must be a structural leaf, not a value field or container",
    )
  return content.ast
}

/** Never let deferred descriptors reach schema walkers or serialized metadata. */
export const assertResolvedFormFields = (
  fields: Schema.Struct.Fields,
): void => {
  const seen = new Set<object>()
  const visit = (value: unknown): void => {
    if (isDeferredValue(value))
      fail("form", "unresolved deferred value: use a supported field option")
    if (typeof value !== "object" || value === null || seen.has(value)) return
    seen.add(value)
    for (const key of Reflect.ownKeys(value)) visit(Reflect.get(value, key))
  }
  visit(Schema.Struct(fields).ast)
}

const operations = new Map<symbol, string>([
  [FormLabel, "label"],
  [FormDescription, "description"],
  [FormAutoComplete, "autoComplete"],
  [FormDefault, "default"],
])

/** Walk both sides of transformations without changing their decoding contract. */
const mapChildren = (
  ast: SchemaAST.AST,
  map: (ast: SchemaAST.AST, path: string) => SchemaAST.AST,
  path: string,
  mapAnnotations: (
    annotations: SchemaAST.Annotations,
    ast: SchemaAST.AST,
    path: string,
  ) => SchemaAST.Annotations,
): SchemaAST.AST => {
  switch (ast._tag) {
    case "TypeLiteral":
      return new SchemaAST.TypeLiteral(
        ast.propertySignatures.map(
          (property) =>
            new SchemaAST.PropertySignature(
              property.name,
              map(property.type, `${path}.${String(property.name)}`),
              property.isOptional,
              property.isReadonly,
              mapAnnotations(
                property.annotations,
                property.type,
                `${path}.${String(property.name)}`,
              ),
            ),
        ),
        ast.indexSignatures,
        ast.annotations,
      )
    case "TupleType":
      return new SchemaAST.TupleType(
        ast.elements.map(
          (element, index) =>
            new SchemaAST.OptionalType(
              map(element.type, `${path}[${index}]`),
              element.isOptional,
              element.annotations,
            ),
        ),
        ast.rest.map(
          (element) =>
            new SchemaAST.Type(
              map(element.type, `${path}[]`),
              element.annotations,
            ),
        ),
        ast.isReadonly,
        ast.annotations,
      )
    case "Union":
      return SchemaAST.Union.make(
        ast.types.map((type) => map(type, path)),
        ast.annotations,
      )
    case "Refinement":
      return new SchemaAST.Refinement(
        map(ast.from, path),
        ast.filter,
        ast.annotations,
      )
    case "Transformation":
      return new SchemaAST.Transformation(
        map(ast.from, path),
        map(ast.to, path),
        ast.transformation,
        ast.annotations,
      )
    case "Suspend":
      return fail(path, "suspended form schemas are not supported")
    default:
      return ast
  }
}

/** Each declaration owns its callbacks; each resolution owns its evaluated values. */
interface FormDeclarationCompiler<
  State,
  Steps extends Record<string, StepMeta | FormStepMeta>,
  Item,
> {
  readonly helpers: FormAuthoring<State, Steps, Item>
  readonly project: <Fields extends Schema.Struct.Fields>(
    fields: Fields,
    args?: readonly [State, FlowContext<Steps>, Item],
  ) => Fields
}

export const createFormAuthoring = <
  State,
  Steps extends Record<string, StepMeta | FormStepMeta>,
  Item,
>(): FormDeclarationCompiler<State, Steps, Item> => {
  const resolvers = new WeakMap<object, Resolver<State, Steps, Item, unknown>>()
  const value = <A>(
    resolve: Resolver<State, Steps, Item, A>,
    fallback?: NoInfer<A>,
  ): DeferredValue<A> => {
    const descriptor: DeferredValue<A> = Object.freeze({
      [DeferredValueTypeId]: true,
      fallback,
    })
    resolvers.set(descriptor, resolve)
    return descriptor
  }
  const helpers: FormAuthoring<State, Steps, Item> = {
    value,
    query: value,
    content: (resolve, fallback = TextBlock("")) => {
      structuralAst(fallback, "content.fallback")
      // The fallback was validated as a structural leaf; annotations preserves it.
      return fallback.annotations({
        [FormDeferredContent]: value(resolve, fallback),
      }) as StructuralContent
    },
  }

  const project = <Fields extends Schema.Struct.Fields>(
    fields: Fields,
    args?: readonly [State, FlowContext<Steps>, Item],
  ): Fields => {
    const evaluated = new Map<object, unknown>()
    const resolve = (
      descriptor: DeferredValue<unknown>,
      path: string,
    ): unknown => {
      const resolver = resolvers.get(descriptor)
      if (!resolver)
        return fail(path, "deferred value belongs to another Form declaration")
      if (!args) return descriptor.fallback
      if (!evaluated.has(descriptor))
        evaluated.set(descriptor, resolver(...args))
      const resolved = evaluated.get(descriptor)
      return resolved === undefined ? descriptor.fallback : resolved
    }
    const visit = (original: SchemaAST.AST, path: string): SchemaAST.AST => {
      const content = original.annotations[FormDeferredContent]
      if (content !== undefined) {
        if (!isDeferredValue(content))
          return fail(path, "invalid deferred content")
        const resolved = resolve(content, path)
        return structuralAst(
          resolved === undefined ? content.fallback : resolved,
          path,
        )
      }
      let ast = mapChildren(original, visit, path, visitAnnotations)
      for (const key of Object.getOwnPropertySymbols(original.annotations)) {
        const annotation = original.annotations[key]
        if (isDeferredValue(annotation)) {
          const operation = operations.get(key)
          if (!operation)
            return fail(
              path,
              "deferred value is not allowed in this schema annotation",
            )
          ast = SchemaAST.annotations(ast, { [key]: undefined })
          ast = decorateAst(
            ast,
            { [operation]: resolve(annotation, path) },
            path,
          )
        } else if (key === FormLookupInput || key === FormCalendarSlotInput) {
          if (
            typeof annotation !== "object" ||
            annotation === null ||
            !("query" in annotation)
          )
            continue
          if (!isDeferredValue(annotation.query)) continue
          const query = annotation.query
          // Bind against this request, but evaluate the factory only when queried.
          // Static projection omits it entirely; no placeholder query is executed.
          ast = SchemaAST.annotations(ast, {
            [key]: { ...annotation, query: undefined },
          })
          if (args) {
            ast = decorateAst(
              ast,
              {
                query: (...queryArgs: unknown[]) => {
                  const bound = resolve(query, path)
                  if (typeof bound !== "function")
                    return fail(path, "query binding must return a function")
                  return bound(...queryArgs)
                },
              },
              path,
            )
          } else if (!resolvers.has(query)) {
            return fail(
              path,
              "deferred query belongs to another Form declaration",
            )
          }
        }
      }
      return ast
    }
    const visitAnnotations = (
      annotations: SchemaAST.Annotations,
      ast: SchemaAST.AST,
      path: string,
    ): SchemaAST.Annotations => {
      if (
        !Object.getOwnPropertySymbols(annotations).some((key) =>
          isDeferredValue(annotations[key]),
        )
      )
        return annotations
      const resolved = visit(
        SchemaAST.annotations(ast, annotations),
        path,
      ).annotations
      return Object.fromEntries(
        Reflect.ownKeys(annotations).map((key) => [key, resolved[key]]),
      )
    }
    const resolved = mapFormFields(
      fields,
      (ast, name) => visit(ast, `form.${name}`),
      (annotations, ast, name) =>
        visitAnnotations(annotations, ast, `form.${name}`),
      (ast, name) => visit(ast, `form.${name}`),
    )
    assertResolvedFormFields(resolved)
    return resolved
  }
  return { helpers: Object.freeze(helpers), project }
}
