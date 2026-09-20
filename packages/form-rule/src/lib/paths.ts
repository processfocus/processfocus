import type {
  FormRule,
  FormRuleExpression,
  FormRulePath,
  RuleValue,
} from "./types"

const collectRuleValuePaths = (
  value: RuleValue,
  paths: FormRulePath[],
): void => {
  if (value._tag === "field") {
    paths.push(value.path)
  }
}

const collectFormRuleConditionPaths = (
  expression: FormRuleExpression,
  paths: FormRulePath[],
): void => {
  switch (expression._tag) {
    case "equals":
    case "notEquals":
    case "numberOrder":
    case "stringOrder":
    case "dateOrder":
      collectRuleValuePaths(expression.left, paths)
      collectRuleValuePaths(expression.right, paths)
      return
    case "in":
    case "notIn":
      collectRuleValuePaths(expression.value, paths)
      collectRuleValuePaths(expression.candidates, paths)
      return
    case "blank":
    case "present":
      collectRuleValuePaths(expression.value, paths)
      return
    case "and":
    case "or":
      for (const child of expression.expressions) {
        collectFormRuleConditionPaths(child, paths)
      }
      return
    case "not":
      collectFormRuleConditionPaths(expression.expression, paths)
      return
    default: {
      const exhaustive: never = expression
      throw new Error(
        `Unexpected form rule expression: ${JSON.stringify(exhaustive)}`,
      )
    }
  }
}

export const formRuleConditionPaths = ({
  expression,
}: {
  readonly expression: FormRuleExpression
}): readonly FormRulePath[] => {
  const paths: FormRulePath[] = []
  collectFormRuleConditionPaths(expression, paths)
  return paths
}

const formRulePathReferencesFieldNames = ({
  path,
  fieldNames,
}: {
  readonly path: FormRulePath
  readonly fieldNames: ReadonlySet<string>
}): boolean => {
  const fieldName = path.every((segment) => typeof segment === "string")
    ? path.join(".")
    : undefined
  if (fieldName !== undefined && fieldNames.has(fieldName)) {
    return true
  }

  const rootFieldName = path[0]
  return typeof rootFieldName === "string" && fieldNames.has(rootFieldName)
}

/** Whether any condition, effect, or otherwise path references a field name. */
export const formRuleReferencesFieldNames = ({
  rule,
  fieldNames,
}: {
  readonly rule: FormRule
  readonly fieldNames: ReadonlySet<string>
}): boolean => {
  const paths = [
    ...formRuleConditionPaths({ expression: rule.condition }),
    ...rule.effects.map((effect) => effect.target),
    ...(rule.otherwise?.map((effect) => effect.target) ?? []),
  ]

  return paths.some((path) =>
    formRulePathReferencesFieldNames({ path, fieldNames }),
  )
}
