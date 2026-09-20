import { Effect, Option } from "effect"
import type {
  AssertConstraintNode,
  AttributeNode,
  BaseDeclaration,
  ExpressionNode,
  ExtendNode,
  Program,
  TypeDeclaration,
} from "./ast.js"
import { SemanticError } from "./errors.js"

export const validateSemantics = (
  program: Program,
): Effect.Effect<void, SemanticError[]> =>
  Effect.gen(function* () {
    const baseMap = buildBaseMap(program.bases)
    const typeMap = buildTypeMap(program.types)

    // Check for duplicate bases
    const baseDuplicateErrors = checkDuplicateBases(program.bases)

    // Check for duplicate types
    const typeDuplicateErrors = checkDuplicateTypes(program.types)

    // Check for cycles in type references
    const cycleErrors = checkTypeCycles(program.types, typeMap)

    // Check for orphaned extends
    const programWithOrphans = program as Program & {
      _orphanedExtends?: Array<{ typeName: string; extend: ExtendNode }>
      _orphanedIndexes?: Array<{ typeName: string; index: { name: string } }>
      _orphanedAsserts?: Array<{
        typeName: string
        assert: AssertConstraintNode
      }>
    }
    const orphanedExtendErrors = programWithOrphans._orphanedExtends
      ? programWithOrphans._orphanedExtends.map((orphaned) => {
          const isBase = baseMap.has(orphaned.typeName)
          const message = isBase
            ? `Cannot extend base type '${orphaned.typeName}'. Only type declarations can be extended.`
            : `Type '${orphaned.typeName}' not found for extend '${orphaned.extend.attributeName}'`
          return new SemanticError({
            message,
            line: orphaned.extend.line ?? 0,
            column: orphaned.extend.column ?? 0,
            context: `Extend: ${orphaned.extend.attributeName}`,
          })
        })
      : []

    // Check for orphaned static asserts
    const orphanedAssertErrors = programWithOrphans._orphanedAsserts
      ? programWithOrphans._orphanedAsserts.map((orphaned) => {
          const isBase = baseMap.has(orphaned.typeName)
          const message = isBase
            ? `Cannot assert on base type '${orphaned.typeName}'. Only type declarations can have assert constraints.`
            : `Type '${orphaned.typeName}' not found for assert '${orphaned.assert.name}'`
          return new SemanticError({
            message,
            line: orphaned.assert.line ?? 0,
            column: orphaned.assert.column ?? 0,
            context: `Assert: ${orphaned.assert.name}`,
          })
        })
      : []

    // Check for orphaned indexes
    const orphanedIndexErrors = programWithOrphans._orphanedIndexes
      ? programWithOrphans._orphanedIndexes.map(
          (orphaned) =>
            new SemanticError({
              message: `Type '${orphaned.typeName}' not found for index '${orphaned.index.name}'`,
              line: 0,
              column: 0,
              context: `Index: ${orphaned.index.name}`,
            }),
        )
      : []

    // Collect initial errors
    const initialErrors = [
      ...baseDuplicateErrors,
      ...typeDuplicateErrors,
      ...cycleErrors,
      ...orphanedExtendErrors,
      ...orphanedIndexErrors,
      ...orphanedAssertErrors,
    ]

    // Validate types (collect all errors)
    const typeValidations = program.types.map((type) =>
      validateType(type, baseMap, typeMap),
    )

    // Collect all validation errors using Effect.all with validate mode
    const allValidations = [...typeValidations]

    if (allValidations.length > 0) {
      yield* Effect.all(allValidations, {
        concurrency: "unbounded",
        mode: "validate",
      }).pipe(
        Effect.catchAll((errorOptions) => {
          const validationErrors = errorOptions.flatMap((option) =>
            Option.getOrElse(option, () => []),
          )
          return Effect.fail([...initialErrors, ...validationErrors])
        }),
      )
    }

    // If there are initial errors but no validation errors, fail with initial errors
    if (initialErrors.length > 0) {
      return yield* Effect.fail(initialErrors)
    }
  })

const buildBaseMap = (
  bases: readonly BaseDeclaration[],
): Map<string, BaseDeclaration> => {
  const map = new Map<string, BaseDeclaration>()
  for (const base of bases) {
    map.set(base.name, base)
  }
  return map
}

const buildTypeMap = (
  types: readonly TypeDeclaration[],
): Map<string, TypeDeclaration> => {
  const map = new Map<string, TypeDeclaration>()
  for (const type of types) {
    map.set(type.name, type)
  }
  return map
}

const checkDuplicateBases = (
  bases: readonly BaseDeclaration[],
): SemanticError[] => {
  const seen = new Set<string>()
  const errors: SemanticError[] = []

  for (const base of bases) {
    if (seen.has(base.name)) {
      errors.push(
        new SemanticError({
          message: `Duplicate base declaration: ${base.name}`,
          line: base.line ?? 0,
          column: base.column ?? 0,
        }),
      )
    } else {
      seen.add(base.name)
    }
  }

  return errors
}

const checkDuplicateTypes = (
  types: readonly TypeDeclaration[],
): SemanticError[] => {
  const seen = new Set<string>()
  const errors: SemanticError[] = []

  for (const type of types) {
    if (seen.has(type.name)) {
      errors.push(
        new SemanticError({
          message: `Duplicate type declaration: ${type.name}`,
          line: type.line ?? 0,
          column: type.column ?? 0,
        }),
      )
    } else {
      seen.add(type.name)
    }
  }

  return errors
}

const checkTypeCycles = (
  types: readonly TypeDeclaration[],
  typeMap: Map<string, TypeDeclaration>,
): SemanticError[] => {
  const errors: SemanticError[] = []
  const visited = new Set<string>()
  const recursionStack = new Set<string>()

  const detectCycle = (typeName: string, path: string[]): string[] | null => {
    if (recursionStack.has(typeName)) {
      // Found a cycle - return the path from the cycle start
      const cycleStartIndex = path.indexOf(typeName)
      return path.slice(cycleStartIndex)
    }

    if (visited.has(typeName)) {
      // Already processed this type and no cycle was found
      return null
    }

    const type = typeMap.get(typeName)
    if (!type) {
      // Type doesn't exist, but that's handled by other validators
      return null
    }

    visited.add(typeName)
    recursionStack.add(typeName)
    path.push(typeName)

    // Check all attributes that reference types
    for (const attr of type.attributes) {
      if (typeMap.has(attr.baseName)) {
        // Skip self-references - they are valid (e.g., tree structures)
        if (attr.baseName === typeName) {
          continue
        }
        // This attribute references another type
        const cyclePath = detectCycle(attr.baseName, [...path])
        if (cyclePath) {
          // Found a cycle, report it
          recursionStack.delete(typeName)
          return cyclePath
        }
      }
    }

    recursionStack.delete(typeName)
    return null
  }

  // Check each type for cycles
  for (const type of types) {
    if (!visited.has(type.name)) {
      const cyclePath = detectCycle(type.name, [])
      if (cyclePath) {
        const cycleDescription = [...cyclePath, cyclePath[0]].join(" -> ")
        errors.push(
          new SemanticError({
            message: `Cycle detected in type references: ${cycleDescription}`,
            line: type.line ?? 0,
            column: type.column ?? 0,
            context: `Type: ${type.name}`,
          }),
        )
        // Mark all types in the cycle as visited to avoid duplicate errors
        for (const cycleName of cyclePath) {
          visited.add(cycleName)
        }
      }
    }
  }

  return errors
}

const validateType = (
  type: TypeDeclaration,
  baseMap: Map<string, BaseDeclaration>,
  typeMap: Map<string, TypeDeclaration>,
): Effect.Effect<void, SemanticError[]> =>
  Effect.gen(function* () {
    const errors: SemanticError[] = []

    // Validate ID prefix if present
    if (type.idPrefix !== undefined) {
      if (type.idPrefix.length === 0) {
        errors.push(
          new SemanticError({
            message: `ID prefix cannot be empty for type '${type.name}'`,
            line: type.line ?? 0,
            column: type.column ?? 0,
          }),
        )
      } else if (type.idPrefix.length > 4) {
        errors.push(
          new SemanticError({
            message: `ID prefix '${type.idPrefix}' for type '${type.name}' cannot be longer than 4 characters`,
            line: type.line ?? 0,
            column: type.column ?? 0,
          }),
        )
      } else {
        // Validate pattern: only letters (lowercase)
        const validPrefixPattern = /^[a-z]+$/
        if (!validPrefixPattern.test(type.idPrefix)) {
          errors.push(
            new SemanticError({
              message: `ID prefix '${type.idPrefix}' for type '${type.name}' must contain only lowercase letters`,
              line: type.line ?? 0,
              column: type.column ?? 0,
            }),
          )
        }
      }
    }

    // If there are prefix errors, fail early
    if (errors.length > 0) {
      return yield* Effect.fail(errors)
    }

    // Validate attributes
    const attrValidations = type.attributes.map((attr) =>
      validateAttribute(attr, type, baseMap, typeMap),
    )

    // Validate indexes
    const indexValidations = [...type.indexes, ...type.uniqueIndexes].map(
      (index) => validateIndex(index, type),
    )

    // Validate extends
    const extendValidations = type.extends.map((extend) =>
      validateExtend(extend, type, typeMap),
    )

    // Validate static assert constraints
    const assertValidations = type.asserts.map((assertion) =>
      validateAssertConstraint(assertion, type),
    )

    // Check for duplicate virtual attribute names
    const virtualAttrErrors = checkDuplicateVirtualAttributes(type)
    const assertNameErrors = checkDuplicateAssertConstraints(type)

    // Run all validations in parallel and collect all errors
    yield* Effect.all(
      [
        ...attrValidations,
        ...indexValidations,
        ...extendValidations,
        ...assertValidations,
      ],
      {
        concurrency: "unbounded",
        mode: "validate",
      },
    ).pipe(
      Effect.mapError((errorOptions) => [
        ...virtualAttrErrors,
        ...assertNameErrors,
        ...errorOptions.flatMap((option) => Option.getOrElse(option, () => [])),
      ]),
    )

    // If only duplicate name errors, fail with those
    if (virtualAttrErrors.length > 0 || assertNameErrors.length > 0) {
      return yield* Effect.fail([...virtualAttrErrors, ...assertNameErrors])
    }
  })

const validateAttribute = (
  attr: AttributeNode,
  type: TypeDeclaration,
  baseMap: Map<string, BaseDeclaration>,
  typeMap: Map<string, TypeDeclaration>,
): Effect.Effect<void, SemanticError[]> =>
  Effect.gen(function* () {
    const errors: SemanticError[] = []

    // Check existence in symbol tables (common for both specialization and regular attributes)
    // Note: baseName should have been resolved by the transformer before validation
    const isBase = baseMap.has(attr.baseName)
    const isType = typeMap.has(attr.baseName)

    if (attr.isSpecialization) {
      // Specializations must reference a type, not a base
      if (isBase) {
        errors.push(
          new SemanticError({
            message: `Specialization '${attr.name}' cannot reference base '${attr.baseName}'. Specializations must reference types.`,
            line: attr.line ?? 0,
            column: attr.column ?? 0,
            context: `Type: ${type.name}, Attribute: ${attr.name}`,
          }),
        )
      } else if (!isType) {
        errors.push(
          new SemanticError({
            message: `Type '${attr.baseName}' not found for specialization '${attr.name}'`,
            line: attr.line ?? 0,
            column: attr.column ?? 0,
            context: `Type: ${type.name}, Attribute: ${attr.name}`,
          }),
        )
      }

      // Specializations cannot be optional (they are always 0..1)
      if (attr.optional) {
        errors.push(
          new SemanticError({
            message: `Specialization '${attr.name}' cannot be optional. Specializations are always 0..1 relationships.`,
            line: attr.line ?? 0,
            column: attr.column ?? 0,
            context: `Type: ${type.name}, Attribute: ${attr.name}`,
          }),
        )
      }
    } else {
      // Regular attributes: can be either base or type
      if (!isBase && !isType) {
        errors.push(
          new SemanticError({
            message: `Base or type '${attr.baseName}' not found for attribute '${attr.name}'`,
            line: attr.line ?? 0,
            column: attr.column ?? 0,
            context: `Type: ${type.name}, Attribute: ${attr.name}`,
          }),
        )
      }

      // Self-references cannot use the "optional" keyword (they are implicitly optional 0..1)
      if (isType && attr.baseName === type.name && attr.optional) {
        errors.push(
          new SemanticError({
            message: `Self-reference '${attr.name}' cannot use the 'optional' keyword in type '${type.name}'. Self-references are implicitly optional (0..1).`,
            line: attr.line ?? 0,
            column: attr.column ?? 0,
            context: `Type: ${type.name}, Attribute: ${attr.name}`,
          }),
        )
      }
    }

    // Validate default and init expressions in parallel
    const expressionValidations: Effect.Effect<void, SemanticError[]>[] = []

    if (attr.default) {
      expressionValidations.push(
        validateExpression(attr.default, type, typeMap),
      )
    }

    if (attr.init) {
      expressionValidations.push(validateExpression(attr.init, type, typeMap))
    }

    if (expressionValidations.length > 0) {
      yield* Effect.all(expressionValidations, {
        concurrency: "unbounded",
        mode: "validate",
      }).pipe(
        Effect.catchAll((errorOptions) => {
          const exprErrors = errorOptions.flatMap((option) =>
            Option.getOrElse(option, () => []),
          )
          errors.push(...exprErrors)
          return Effect.void
        }),
      )
    }

    if (errors.length > 0) {
      return yield* Effect.fail(errors)
    }
  })

const validateIndex = (
  index: {
    name: string
    attributes: readonly string[]
    unique: boolean
    line?: number
    column?: number
  },
  type: TypeDeclaration,
): Effect.Effect<void, SemanticError[]> =>
  Effect.gen(function* () {
    const errors: SemanticError[] = []

    for (const attrName of index.attributes) {
      const found = type.attributes.find((a) => a.name === attrName)
      if (!found) {
        errors.push(
          new SemanticError({
            message: `Attribute '${attrName}' not found in type '${type.name}' for index '${index.name}'`,
            line: index.line ?? 0,
            column: index.column ?? 0,
            context: `Type: ${type.name}, Index: ${index.name}`,
          }),
        )
      }
    }

    if (errors.length > 0) {
      return yield* Effect.fail(errors)
    }
  })

/**
 * Validate perPath in retrieval functions.
 * perPath must be a chain of type references (foreign keys) starting from the aggregated type.
 * Each attribute in the chain must exist and must be a type reference.
 */
const validatePerPath = (
  perPath: ExpressionNode,
  aggregatedType: TypeDeclaration,
  typeMap: Map<string, TypeDeclaration>,
): SemanticError[] => {
  const errors: SemanticError[] = []

  if (perPath.kind !== "path" || perPath.segments.length === 0) {
    return errors
  }

  let currentType = aggregatedType

  for (let i = 0; i < perPath.segments.length; i++) {
    const segment = perPath.segments[i]
    if (!segment) continue

    // Find the attribute in the current type
    const attr = currentType.attributes.find((a) => a.name === segment)

    if (!attr) {
      errors.push(
        new SemanticError({
          message: `perPath attribute '${segment}' not found in type '${currentType.name}'`,
          line: 0,
          column: 0,
          context: `perPath: ${perPath.segments.join(" its ")}, Type: ${currentType.name}`,
        }),
      )
      break
    }

    // Check if the attribute is a type reference (foreign key)
    const referencedType = typeMap.get(attr.baseName)
    if (!referencedType) {
      errors.push(
        new SemanticError({
          message: `perPath attribute '${segment}' in type '${currentType.name}' must be a type reference, but '${attr.baseName}' is not a type`,
          line: 0,
          column: 0,
          context: `perPath: ${perPath.segments.join(" its ")}`,
        }),
      )
      break
    }

    // Move to the referenced type for next iteration
    currentType = referencedType
  }

  return errors
}

const validateExpression = (
  expr: ExpressionNode,
  type: TypeDeclaration,
  typeMap: Map<string, TypeDeclaration>,
): Effect.Effect<void, SemanticError[]> =>
  Effect.gen(function* () {
    const errors: SemanticError[] = []

    switch (expr.kind) {
      case "literal":
        // Literals are always valid
        break

      case "identifier": {
        // Check if identifier refers to an attribute in the current type (regular or virtual)
        const foundAttr = type.attributes.find((a) => a.name === expr.name)
        const foundExtend = type.extends.find(
          (e) => e.attributeName === expr.name,
        )
        if (!foundAttr && !foundExtend) {
          // Could also be a system function like system_date
          if (!isSystemFunction(expr.name)) {
            errors.push(
              new SemanticError({
                message: `Identifier '${expr.name}' not found in type '${type.name}'`,
                line: 0,
                column: 0,
                context: `Type: ${type.name}`,
              }),
            )
          }
        }
        break
      }

      case "binary_op": {
        // Validate left and right expressions in parallel
        yield* Effect.all(
          [
            validateExpression(expr.left, type, typeMap),
            validateExpression(expr.right, type, typeMap),
          ],
          {
            concurrency: "unbounded",
            mode: "validate",
          },
        ).pipe(
          Effect.catchAll((errorOptions) => {
            const binaryErrors = errorOptions.flatMap((option) =>
              Option.getOrElse(option, () => []),
            )
            errors.push(...binaryErrors)
            return Effect.void
          }),
        )
        break
      }

      case "conditional": {
        // Validate condition, then, and else expressions in parallel
        yield* Effect.all(
          [
            validateExpression(expr.condition, type, typeMap),
            validateExpression(expr.thenExpr, type, typeMap),
            validateExpression(expr.elseExpr, type, typeMap),
          ],
          {
            concurrency: "unbounded",
            mode: "validate",
          },
        ).pipe(
          Effect.catchAll((errorOptions) => {
            const condErrors = errorOptions.flatMap((option) =>
              Option.getOrElse(option, () => []),
            )
            errors.push(...condErrors)
            return Effect.void
          }),
        )
        break
      }

      case "path": {
        // Validate path: first segment should be an attribute, rest should be valid traversals
        if (expr.segments.length > 0) {
          const firstSegment = expr.segments[0]
          const attr = type.attributes.find((a) => a.name === firstSegment)
          if (!attr) {
            errors.push(
              new SemanticError({
                message: `Path start '${firstSegment}' not found in type '${type.name}'`,
                line: 0,
                column: 0,
                context: `Type: ${type.name}, Path: ${expr.segments.join(" its ")}`,
              }),
            )
          } else {
            // Validate rest of path (would need more type info to fully validate)
            // For now, just check that referenced types exist
            let currentType = typeMap.get(attr.baseName)
            for (let i = 1; i < expr.segments.length; i++) {
              if (!currentType) break
              const segment = expr.segments[i]
              const nextAttr = currentType.attributes.find(
                (a) => a.name === segment,
              )
              if (!nextAttr) {
                errors.push(
                  new SemanticError({
                    message: `Path segment '${segment}' not found in type '${currentType.name}'`,
                    line: 0,
                    column: 0,
                    context: `Path: ${expr.segments.join(" its ")}`,
                  }),
                )
                break
              }
              currentType = typeMap.get(nextAttr.baseName)
            }
          }
        }
        break
      }

      case "retrieval_function": {
        // Validate retrieval function expression
        const validationEffects: Effect.Effect<void, SemanticError[]>[] = []

        // Look up the type being aggregated
        const aggregatedType = typeMap.get(expr.typeName)
        if (!aggregatedType) {
          errors.push(
            new SemanticError({
              message: `Type '${expr.typeName}' not found for retrieval function`,
              line: 0,
              column: 0,
              context: `Type: ${type.name}`,
            }),
          )
          break
        }

        // Validate the expression if present (in context of aggregated type)
        if (expr.expression) {
          // For count, nil, any - expression should be a simple path (semantic validation)
          if (
            expr.function === "count" ||
            expr.function === "nil" ||
            expr.function === "any"
          ) {
            // Expression should be a simple identifier or path
            if (
              expr.expression.kind !== "identifier" &&
              expr.expression.kind !== "path"
            ) {
              errors.push(
                new SemanticError({
                  message: `Retrieval function '${expr.function}' should only reference a type path, not a complex expression`,
                  line: 0,
                  column: 0,
                  context: `Type: ${type.name}`,
                }),
              )
            }
          }

          validationEffects.push(
            validateExpression(expr.expression, aggregatedType, typeMap),
          )
        }

        // Validate where predicate if present (in context of aggregated type)
        if (expr.wherePredicate) {
          validationEffects.push(
            validateExpression(expr.wherePredicate, aggregatedType, typeMap),
          )
        }

        // Validate per path with stricter rules - must be chain of type references
        const perPathErrors = validatePerPath(
          expr.perPath,
          aggregatedType,
          typeMap,
        )
        if (perPathErrors.length > 0) {
          errors.push(...perPathErrors)
        }

        if (validationEffects.length > 0) {
          yield* Effect.all(validationEffects, {
            concurrency: "unbounded",
            mode: "validate",
          }).pipe(
            Effect.catchAll((errorOptions) => {
              const retrievalErrors = errorOptions.flatMap((option) =>
                Option.getOrElse(option, () => []),
              )
              errors.push(...retrievalErrors)
              return Effect.void
            }),
          )
        }
        break
      }
    }

    if (errors.length > 0) {
      return yield* Effect.fail(errors)
    }
  })

const isSystemFunction = (name: string): boolean => {
  const systemFunctions = ["system_date", "system_time", "system_timestamp"]
  return systemFunctions.includes(name)
}

const validateExtend = (
  extend: ExtendNode,
  type: TypeDeclaration,
  typeMap: Map<string, TypeDeclaration>,
): Effect.Effect<void, SemanticError[]> =>
  Effect.gen(function* () {
    const errors: SemanticError[] = []

    // Validate that extend attribute doesn't conflict with regular attributes
    const conflictingAttr = type.attributes.find(
      (a) => a.name === extend.attributeName,
    )
    if (conflictingAttr) {
      errors.push(
        new SemanticError({
          message: `Virtual attribute '${extend.attributeName}' conflicts with regular attribute in type '${type.name}'`,
          line: extend.line ?? 0,
          column: extend.column ?? 0,
          context: `Type: ${type.name}, Extend: ${extend.attributeName}`,
        }),
      )
    }

    // Validate cardinality if present (for asserts)
    if (extend.cardinality) {
      if (
        extend.cardinality.max !== "unbounded" &&
        extend.cardinality.min > extend.cardinality.max
      ) {
        errors.push(
          new SemanticError({
            message: `Invalid cardinality: min (${extend.cardinality.min}) > max (${extend.cardinality.max})`,
            line: extend.line ?? 0,
            column: extend.column ?? 0,
            context: `Type: ${type.name}, Extend: ${extend.attributeName}`,
          }),
        )
      }
    }

    // Validate expression
    yield* validateExpression(extend.expression, type, typeMap).pipe(
      Effect.catchAll((exprErrors) => {
        errors.push(...exprErrors)
        return Effect.void
      }),
    )

    if (errors.length > 0) {
      return yield* Effect.fail(errors)
    }
  })

const validateAssertConstraint = (
  assertion: AssertConstraintNode,
  type: TypeDeclaration,
): Effect.Effect<void, SemanticError[]> =>
  Effect.gen(function* () {
    const errors = [
      ...validateStaticAssertExpression(assertion.expression, assertion, type),
      ...validateStaticAssertBooleanShape(
        assertion.expression,
        assertion,
        type,
      ),
    ]

    if (errors.length > 0) {
      return yield* Effect.fail(errors)
    }
  })

const isStaticAssertComparisonOperator = (operator: string): boolean =>
  operator === "==" ||
  operator === "!=" ||
  operator === ">=" ||
  operator === "<=" ||
  operator === ">" ||
  operator === "<"

const validateStaticAssertBooleanShape = (
  expr: ExpressionNode,
  assertion: AssertConstraintNode,
  type: TypeDeclaration,
): SemanticError[] => {
  if (expr.kind === "binary_op") {
    if (expr.operator === "or") {
      return [
        ...validateStaticAssertBooleanShape(expr.left, assertion, type),
        ...validateStaticAssertBooleanShape(expr.right, assertion, type),
      ]
    }

    if (isStaticAssertComparisonOperator(expr.operator)) {
      return []
    }
  }

  if (
    expr.kind === "conditional" ||
    expr.kind === "path" ||
    expr.kind === "retrieval_function"
  ) {
    return []
  }

  return [
    new SemanticError({
      message: `Static assert '${assertion.name}' in type '${type.name}' must be a boolean expression`,
      line: assertion.line ?? 0,
      column: assertion.column ?? 0,
      context: `Type: ${type.name}, Assert: ${assertion.name}`,
    }),
  ]
}

const validateStaticAssertExpression = (
  expr: ExpressionNode,
  assertion: AssertConstraintNode,
  type: TypeDeclaration,
): SemanticError[] => {
  const errors: SemanticError[] = []

  switch (expr.kind) {
    case "literal":
      break

    case "identifier": {
      const foundAttr = type.attributes.find((a) => a.name === expr.name)
      if (!foundAttr) {
        errors.push(
          new SemanticError({
            message: `Identifier '${expr.name}' not found in type '${type.name}' for assert '${assertion.name}'`,
            line: assertion.line ?? 0,
            column: assertion.column ?? 0,
            context: `Type: ${type.name}, Assert: ${assertion.name}`,
          }),
        )
      }
      break
    }

    case "binary_op":
      errors.push(
        ...validateStaticAssertExpression(expr.left, assertion, type),
        ...validateStaticAssertExpression(expr.right, assertion, type),
      )
      break

    case "conditional":
      errors.push(
        new SemanticError({
          message: `Static assert '${assertion.name}' in type '${type.name}' does not support conditional expressions`,
          line: assertion.line ?? 0,
          column: assertion.column ?? 0,
          context: `Type: ${type.name}, Assert: ${assertion.name}`,
        }),
      )
      break

    case "path":
      errors.push(
        new SemanticError({
          message: `Static assert '${assertion.name}' in type '${type.name}' can only reference attributes on the same type; path '${expr.segments.join(" its ")}' is not supported`,
          line: assertion.line ?? 0,
          column: assertion.column ?? 0,
          context: `Type: ${type.name}, Assert: ${assertion.name}`,
        }),
      )
      break

    case "retrieval_function":
      errors.push(
        new SemanticError({
          message: `Static assert '${assertion.name}' in type '${type.name}' does not support retrieval functions`,
          line: assertion.line ?? 0,
          column: assertion.column ?? 0,
          context: `Type: ${type.name}, Assert: ${assertion.name}`,
        }),
      )
      break
  }

  return errors
}

const checkDuplicateVirtualAttributes = (
  type: TypeDeclaration,
): SemanticError[] => {
  const seen = new Set<string>()
  const errors: SemanticError[] = []

  for (const extend of type.extends) {
    if (seen.has(extend.attributeName)) {
      errors.push(
        new SemanticError({
          message: `Duplicate virtual attribute: ${extend.attributeName} in type '${type.name}'`,
          line: extend.line ?? 0,
          column: extend.column ?? 0,
          context: `Type: ${type.name}`,
        }),
      )
    } else {
      seen.add(extend.attributeName)
    }
  }

  return errors
}

const checkDuplicateAssertConstraints = (
  type: TypeDeclaration,
): SemanticError[] => {
  const seen = new Set<string>()
  const errors: SemanticError[] = []

  for (const assertion of type.asserts) {
    if (seen.has(assertion.name)) {
      errors.push(
        new SemanticError({
          message: `Duplicate assert constraint: ${assertion.name} in type '${type.name}'`,
          line: assertion.line ?? 0,
          column: assertion.column ?? 0,
          context: `Type: ${type.name}`,
        }),
      )
    } else {
      seen.add(assertion.name)
    }
  }

  return errors
}
