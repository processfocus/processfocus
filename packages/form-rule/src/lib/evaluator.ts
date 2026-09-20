import type {
  FormRuleEvaluationInput,
  FormRuleEvaluationResult,
  FormRuleExpression,
  FormRuleLiteral,
  FormRulePath,
  FormRuleTargetState,
  FormRuleTargetStateEntry,
  FormRuleValues,
  OrderingOperator,
  RuleValue,
} from "./types"

type ResolvedValue =
  | {
      readonly available: true
      readonly value: unknown
    }
  | {
      readonly available: false
    }

const unavailable: ResolvedValue = { available: false }

type ExpressionResult = "match" | "noMatch" | "unavailable"

interface ParsedDateTime {
  readonly epochMilliseconds: number
  readonly subMillisecondDigits: string
}

export function evaluateFormRules(
  input: FormRuleEvaluationInput,
): FormRuleEvaluationResult {
  const targets = new Map<string, FormRuleTargetState>()
  const paths = new Map<string, FormRulePath>()

  for (const entry of input.baseState ?? []) {
    setTargetState(paths, targets, entry.path, entry.state)
  }

  for (const rule of input.rules) {
    const matches = evaluateExpression(rule.condition, input)
    // Unavailable controls are non-matches so rules can safely fall back.
    const effects = matches === "match" ? rule.effects : (rule.otherwise ?? [])
    for (const effect of effects) {
      setTargetState(paths, targets, effect.target, effect.state)
    }
  }

  return { targets: effectiveTargets(paths, targets) }
}

function evaluateExpression(
  expression: FormRuleExpression,
  input: FormRuleEvaluationInput,
): ExpressionResult {
  switch (expression._tag) {
    case "equals":
      return compareResolvedValues(
        resolveRuleValue(expression.left, input),
        resolveRuleValue(expression.right, input),
        literalEquals,
      )
    case "notEquals":
      return compareResolvedValues(
        resolveRuleValue(expression.left, input),
        resolveRuleValue(expression.right, input),
        (left, right) => !literalEquals(left, right),
      )
    case "in":
      return evaluateMembership(expression.value, expression.candidates, input)
    case "notIn":
      return invertResult(
        evaluateMembership(expression.value, expression.candidates, input),
      )
    case "blank": {
      const resolved = resolveRuleValue(expression.value, input)
      // Missing fields are unavailable to comparisons but blank to presence checks.
      return !resolved.available || isBlank(resolved.value)
        ? "match"
        : "noMatch"
    }
    case "present": {
      const resolved = resolveRuleValue(expression.value, input)
      return resolved.available && !isBlank(resolved.value)
        ? "match"
        : "noMatch"
    }
    case "and":
      return evaluateAnd(expression.expressions, input)
    case "or":
      return evaluateOr(expression.expressions, input)
    case "not":
      return invertResult(evaluateExpression(expression.expression, input))
    case "numberOrder":
      return evaluateNumberOrder(
        expression.operator,
        expression.left,
        expression.right,
        input,
      )
    case "stringOrder":
      return evaluateStringOrder(
        expression.operator,
        expression.left,
        expression.right,
        input,
      )
    case "dateOrder":
      return evaluateDateOrder(
        expression.operator,
        expression.left,
        expression.right,
        input,
      )
  }
}

function compareResolvedValues(
  left: ResolvedValue,
  right: ResolvedValue,
  compare: (left: FormRuleLiteral, right: FormRuleLiteral) => boolean,
): ExpressionResult {
  if (!(left.available && right.available)) {
    return "unavailable"
  }

  if (!(isRuleLiteral(left.value) && isRuleLiteral(right.value))) {
    return "unavailable"
  }

  return compare(left.value, right.value) ? "match" : "noMatch"
}

function evaluateMembership(
  valueRef: RuleValue,
  candidatesRef: RuleValue,
  input: FormRuleEvaluationInput,
): ExpressionResult {
  const value = resolveRuleValue(valueRef, input)
  const candidates = resolveRuleValue(candidatesRef, input)

  if (
    !(
      value.available &&
      candidates.available &&
      Array.isArray(candidates.value)
    )
  ) {
    return "unavailable"
  }

  const memberValue = value.value
  if (!isRuleLiteral(memberValue) || !candidates.value.every(isRuleLiteral)) {
    return "unavailable"
  }

  return candidates.value.some((candidate) =>
    literalEquals(candidate, memberValue),
  )
    ? "match"
    : "noMatch"
}

function evaluateNumberOrder(
  operator: OrderingOperator,
  leftRef: RuleValue,
  rightRef: RuleValue,
  input: FormRuleEvaluationInput,
): ExpressionResult {
  const left = resolveRuleValue(leftRef, input)
  const right = resolveRuleValue(rightRef, input)

  if (!(left.available && right.available)) {
    return "unavailable"
  }

  if (!(typeof left.value === "number" && typeof right.value === "number")) {
    return "unavailable"
  }

  return compareOrdered(operator, left.value, right.value) ? "match" : "noMatch"
}

function evaluateStringOrder(
  operator: OrderingOperator,
  leftRef: RuleValue,
  rightRef: RuleValue,
  input: FormRuleEvaluationInput,
): ExpressionResult {
  const left = resolveRuleValue(leftRef, input)
  const right = resolveRuleValue(rightRef, input)

  if (!(left.available && right.available)) {
    return "unavailable"
  }

  if (!(typeof left.value === "string" && typeof right.value === "string")) {
    return "unavailable"
  }

  return compareOrdered(operator, left.value, right.value) ? "match" : "noMatch"
}

function evaluateDateOrder(
  operator: OrderingOperator,
  leftRef: RuleValue,
  rightRef: RuleValue,
  input: FormRuleEvaluationInput,
): ExpressionResult {
  const left = resolveRuleValue(leftRef, input)
  const right = resolveRuleValue(rightRef, input)

  if (!(left.available && right.available)) {
    return "unavailable"
  }

  if (!(typeof left.value === "string" && typeof right.value === "string")) {
    return "unavailable"
  }

  const leftTime = parseIsoDateTime(left.value)
  const rightTime = parseIsoDateTime(right.value)

  if (leftTime === undefined || rightTime === undefined) {
    return "unavailable"
  }

  return compareDateTimes(operator, leftTime, rightTime) ? "match" : "noMatch"
}

function compareOrdered<T extends number | string>(
  operator: OrderingOperator,
  left: T,
  right: T,
): boolean {
  switch (operator) {
    case "lt":
      return left < right
    case "lte":
      return left <= right
    case "gt":
      return left > right
    case "gte":
      return left >= right
  }
}

function compareDateTimes(
  operator: OrderingOperator,
  left: ParsedDateTime,
  right: ParsedDateTime,
): boolean {
  if (left.epochMilliseconds !== right.epochMilliseconds) {
    return compareOrdered(
      operator,
      left.epochMilliseconds,
      right.epochMilliseconds,
    )
  }

  return compareDecimalDigits(
    operator,
    left.subMillisecondDigits,
    right.subMillisecondDigits,
  )
}

function compareDecimalDigits(
  operator: OrderingOperator,
  left: string,
  right: string,
): boolean {
  const width = Math.max(left.length, right.length)
  const paddedLeft = left.padEnd(width, "0")
  const paddedRight = right.padEnd(width, "0")
  const comparison =
    paddedLeft === paddedRight ? 0 : paddedLeft < paddedRight ? -1 : 1

  switch (operator) {
    case "lt":
      return comparison < 0
    case "lte":
      return comparison <= 0
    case "gt":
      return comparison > 0
    case "gte":
      return comparison >= 0
  }
}

function resolveRuleValue(
  ruleValue: RuleValue,
  input: FormRuleEvaluationInput,
): ResolvedValue {
  switch (ruleValue._tag) {
    case "literal":
      return { available: true, value: ruleValue.value }
    case "field": {
      const values =
        ruleValue.source === "base" ? input.baseValues : input.values
      return values === undefined
        ? unavailable
        : getPathValue(values, ruleValue.path)
    }
  }
}

function getPathValue(
  values: FormRuleValues,
  path: FormRulePath,
): ResolvedValue {
  let current: unknown = values

  for (const segment of path) {
    // String segments are literal keys in v1; future wildcards need a tagged segment.
    if (typeof segment === "number") {
      if (!Array.isArray(current) || !Object.hasOwn(current, segment)) {
        return unavailable
      }

      current = current[segment]
      continue
    }

    if (!isRecord(current) || !Object.hasOwn(current, segment)) {
      return unavailable
    }

    current = current[segment]
  }

  return { available: true, value: current }
}

function isBlank(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  )
}

function isRuleLiteral(value: unknown): value is FormRuleLiteral {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true
  }

  return Array.isArray(value) && value.every(isRuleLiteral)
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function literalEquals(left: FormRuleLiteral, right: FormRuleLiteral): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!(Array.isArray(left) && Array.isArray(right))) {
      return false
    }

    return (
      left.length === right.length &&
      left.every((leftItem, index) => literalEquals(leftItem, right[index]))
    )
  }

  return Object.is(left, right)
}

function evaluateAnd(
  expressions: readonly FormRuleExpression[],
  input: FormRuleEvaluationInput,
): ExpressionResult {
  let sawUnavailable = false

  for (const expression of expressions) {
    const result = evaluateExpression(expression, input)
    if (result === "noMatch") {
      return "noMatch"
    }
    if (result === "unavailable") {
      sawUnavailable = true
    }
  }

  return sawUnavailable ? "unavailable" : "match"
}

function evaluateOr(
  expressions: readonly FormRuleExpression[],
  input: FormRuleEvaluationInput,
): ExpressionResult {
  let sawUnavailable = false

  for (const expression of expressions) {
    const result = evaluateExpression(expression, input)
    if (result === "match") {
      return "match"
    }
    if (result === "unavailable") {
      sawUnavailable = true
    }
  }

  return sawUnavailable ? "unavailable" : "noMatch"
}

function invertResult(result: ExpressionResult): ExpressionResult {
  switch (result) {
    case "match":
      return "noMatch"
    case "noMatch":
      return "match"
    case "unavailable":
      return "unavailable"
  }
}

function setTargetState(
  paths: Map<string, FormRulePath>,
  targets: Map<string, FormRuleTargetState>,
  path: FormRulePath,
  state: FormRuleTargetState,
): void {
  const key = pathKey(path)
  paths.set(key, path)
  targets.set(key, { ...(targets.get(key) ?? {}), ...state })
}

function effectiveTargets(
  paths: ReadonlyMap<string, FormRulePath>,
  targets: ReadonlyMap<string, FormRuleTargetState>,
): readonly FormRuleTargetStateEntry[] {
  const entries = Array.from(paths.entries())

  return entries.map(([key, path]) => {
    const exact = targets.get(key) ?? {}
    let inheritedHidden = false
    let inheritedDisabled = false

    for (const [candidateKey, candidatePath] of entries) {
      if (candidateKey === key || !isAncestorPath(candidatePath, path)) {
        continue
      }

      const candidateState = targets.get(candidateKey)
      inheritedHidden = inheritedHidden || candidateState?.hidden === true
      inheritedDisabled = inheritedDisabled || candidateState?.disabled === true
    }

    return {
      path,
      state: {
        ...exact,
        ...(inheritedHidden ? { hidden: true } : {}),
        ...(inheritedDisabled ? { disabled: true } : {}),
      },
    }
  })
}

function isAncestorPath(candidate: FormRulePath, path: FormRulePath): boolean {
  return (
    candidate.length < path.length &&
    candidate.every((segment, index) => segment === path[index])
  )
}

function pathKey(path: FormRulePath): string {
  return JSON.stringify(path)
}

function parseIsoDateTime(value: string): ParsedDateTime | undefined {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})?)?$/.exec(
      value,
    )
  if (match === null) {
    return undefined
  }

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = match[4] === undefined ? 0 : Number(match[4])
  const minute = match[5] === undefined ? 0 : Number(match[5])
  const second = match[6] === undefined ? 0 : Number(match[6])

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return undefined
  }

  const fraction = match[7]
  const timezone = match[8]
  const normalized =
    match[4] === undefined
      ? value
      : // Naive serialized datetimes are normalized as UTC for browser/server parity.
        `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}${fraction === undefined ? "" : `.${fraction.slice(0, 3).padEnd(3, "0")}`}${timezone ?? "Z"}`
  const time = Date.parse(normalized)
  if (!Number.isFinite(time)) {
    return undefined
  }

  const subMillisecondDigits =
    fraction === undefined || fraction.length <= 3
      ? ""
      : fraction.slice(3).replace(/0+$/, "")
  return { epochMilliseconds: time, subMillisecondDigits }
}

function daysInMonth(year: number, month: number): number {
  // Day zero of the following UTC month is the final day of the requested month.
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}
