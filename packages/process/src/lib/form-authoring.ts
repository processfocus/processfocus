import { Array as Arr, Schema, SchemaAST } from "effect"
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

type StructuralContent = Schema.Top & StructuralOnlyMarker
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
    content.ast._tag !== "Undefined" ||
    Reflect.get(content.ast.annotations ?? {}, STRUCTURAL_ONLY_SYMBOL) !==
      true ||
    Reflect.get(content.ast.annotations ?? {}, FormDeferredContent) !==
      undefined
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
    annotations: Record<PropertyKey, unknown>,
    ast: SchemaAST.AST,
    path: string,
  ) => Record<PropertyKey, unknown>,
): SchemaAST.AST => {
  const encoding = ast.encoding
    ? Arr.map(
        ast.encoding,
        (link) => new SchemaAST.Link(map(link.to, path), link.transformation),
      )
    : undefined
  const context = ast.context
    ? new SchemaAST.Context(
        ast.context.isOptional,
        ast.context.isMutable,
        ast.context.constructorDefault,
        mapAnnotations({ ...ast.context.annotations }, ast, path),
      )
    : undefined
  switch (ast._tag) {
    case "Objects":
      return new SchemaAST.Objects(
        ast.propertySignatures.map(
          (property) =>
            new SchemaAST.PropertySignature(
              property.name,
              map(property.type, `${path}.${String(property.name)}`),
            ),
        ),
        ast.indexSignatures,
        ast.annotations,
        ast.checks,
        encoding,
        context,
        ast.encodingChecks,
      )
    case "Arrays":
      return new SchemaAST.Arrays(
        ast.isMutable,
        ast.elements.map((element, index) => map(element, `${path}[${index}]`)),
        ast.rest.map((element) => map(element, `${path}[]`)),
        ast.annotations,
        ast.checks,
        encoding,
        context,
        ast.encodingChecks,
      )
    case "Union":
      return new SchemaAST.Union(
        ast.types.map((type) => map(type, path)),
        ast.options,
        ast.annotations,
        ast.checks,
        encoding,
        context,
        ast.encodingChecks,
      )
    case "Suspend":
      return fail(path, "suspended form schemas are not supported")
    default:
      return Object.assign(Object.create(Object.getPrototypeOf(ast)), ast, {
        encoding,
        context,
      })
  }
}

const annotateAst = (
  ast: SchemaAST.AST,
  annotations: Record<PropertyKey, unknown>,
): SchemaAST.AST =>
  Schema.make<Schema.Top>(
    Object.assign(Object.create(Object.getPrototypeOf(ast)), ast, {
      annotations: { ...ast.annotations, ...annotations },
    }),
  ).annotate(annotations).ast

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
      return fallback.annotate({
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
    const inputOwners = new Map<string, SchemaAST.AST>()
    const visit = (source: SchemaAST.AST, path: string): SchemaAST.AST => {
      // Effect stores annotations added after a check on that check. Bring form
      // metadata onto the field so deferred values are resolved exactly once.
      const annotations: Record<PropertyKey, unknown> = {
        ...source.annotations,
      }
      const checks = source.checks
        ? Arr.map(source.checks, (check) => {
            const remaining = { ...check.annotations }
            for (const key of [
              ...operations.keys(),
              FormLookupInput,
              FormCalendarSlotInput,
              FormDeferredContent,
            ]) {
              const annotation = Reflect.get(remaining, key)
              if (annotation === undefined) continue
              annotations[key] = annotation
              Reflect.deleteProperty(remaining, key)
            }
            return Object.assign(
              Object.create(Object.getPrototypeOf(check)),
              check,
              { annotations: remaining },
            )
          })
        : undefined
      const original: SchemaAST.AST = Object.assign(
        Object.create(Object.getPrototypeOf(source)),
        source,
        { annotations, checks },
      )
      if (!inputOwners.has(path)) inputOwners.set(path, original)
      const content = Reflect.get(
        original.annotations ?? {},
        FormDeferredContent,
      )
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
      for (const key of Object.getOwnPropertySymbols(
        original.annotations ?? {},
      )) {
        const annotation = Reflect.get(original.annotations ?? {}, key)
        if (isDeferredValue(annotation)) {
          const operation = operations.get(key)
          if (!operation)
            return fail(
              path,
              "deferred value is not allowed in this schema annotation",
            )
          ast = annotateAst(ast, { [key]: undefined })
          ast = decorateAst(
            ast,
            { [operation]: resolve(annotation, path) },
            path,
            inputOwners.get(path),
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
          ast = annotateAst(ast, {
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
      annotations: Record<PropertyKey, unknown>,
      ast: SchemaAST.AST,
      path: string,
    ): Record<PropertyKey, unknown> => {
      if (
        !Object.getOwnPropertySymbols(annotations).some((key) =>
          isDeferredValue(annotations[key]),
        )
      )
        return annotations
      const resolved = visit(annotateAst(ast, annotations), path).annotations
      return Object.fromEntries(
        Reflect.ownKeys(annotations).map((key) => [
          key,
          Reflect.get(resolved ?? {}, key),
        ]),
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
