export type FormRuleLiteral =
  | string
  | number
  | boolean
  | null
  | readonly FormRuleLiteral[]

export type FormRuleValues = Readonly<Record<string, unknown>>

export type FormRuleValueSource = "current" | "base"

export type FormRulePathSegment = string | number

export type FormRulePath = readonly FormRulePathSegment[]

export type RuleValue =
  | {
      readonly _tag: "literal"
      readonly value: FormRuleLiteral
    }
  | {
      readonly _tag: "field"
      readonly path: FormRulePath
      readonly source?: FormRuleValueSource
    }

export type OrderingOperator = "lt" | "lte" | "gt" | "gte"

export type FormRuleExpression =
  | {
      readonly _tag: "equals"
      readonly left: RuleValue
      readonly right: RuleValue
    }
  | {
      readonly _tag: "notEquals"
      readonly left: RuleValue
      readonly right: RuleValue
    }
  | {
      readonly _tag: "in"
      readonly value: RuleValue
      readonly candidates: RuleValue
    }
  | {
      readonly _tag: "notIn"
      readonly value: RuleValue
      readonly candidates: RuleValue
    }
  | {
      readonly _tag: "blank"
      readonly value: RuleValue
    }
  | {
      readonly _tag: "present"
      readonly value: RuleValue
    }
  | {
      readonly _tag: "and"
      readonly expressions: readonly FormRuleExpression[]
    }
  | {
      readonly _tag: "or"
      readonly expressions: readonly FormRuleExpression[]
    }
  | {
      readonly _tag: "not"
      readonly expression: FormRuleExpression
    }
  | {
      readonly _tag: "numberOrder"
      readonly operator: OrderingOperator
      readonly left: RuleValue
      readonly right: RuleValue
    }
  | {
      readonly _tag: "stringOrder"
      readonly operator: OrderingOperator
      readonly left: RuleValue
      readonly right: RuleValue
    }
  | {
      readonly _tag: "dateOrder"
      readonly operator: OrderingOperator
      readonly left: RuleValue
      readonly right: RuleValue
    }

export interface FormRuleTargetState {
  readonly hidden?: boolean
  readonly disabled?: boolean
  readonly required?: boolean
  readonly label?: string
}

export interface FormRuleEffect {
  readonly target: FormRulePath
  readonly state: FormRuleTargetState
}

export interface FormRuleTargetStateEntry {
  readonly path: FormRulePath
  readonly state: FormRuleTargetState
}

export interface FormRule {
  readonly condition: FormRuleExpression
  readonly effects: readonly FormRuleEffect[]
  readonly otherwise?: readonly FormRuleEffect[]
}

export interface FormRuleEvaluationInput {
  readonly rules: readonly FormRule[]
  readonly values: FormRuleValues
  readonly baseValues?: FormRuleValues
  readonly baseState?: readonly FormRuleTargetStateEntry[]
}

export interface FormRuleEvaluationResult {
  readonly targets: readonly FormRuleTargetStateEntry[]
}
