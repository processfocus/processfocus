export interface AuthorizationAction {
  id: string
  principalTypes: string[]
  resourceTypes: string[]
}

export type ResourceAttrControl =
  | { control: "boolean"; name: string; required: boolean }
  | { control: "string"; name: string; required: boolean }
  | { control: "principal"; name: string; required: boolean }
  | { control: "role"; name: string; required: boolean }
  | { control: "roleSet"; name: string; required: boolean }
  | { control: "related"; name: string; required: boolean; entityType: string }

export interface AuthorizationEntityType {
  typeName: string
  memberOf: string[]
  attributes: ResourceAttrControl[]
}

export interface AuthorizationCedar {
  actions: AuthorizationAction[]
  entities: AuthorizationEntityType[]
  policiesText: string
  schemaText: string
  loadError: string | null
}

export interface AuthorizationEvalInput {
  principal: { type: string; id: string }
  roles: readonly string[]
  orgUnitId: string
  action: string
  resource: { type: string; id: string }
  processPath: string | null
  entity: AuthorizationEntityType | null
  attrValues: Record<string, boolean | string>
}

interface HandbookItem {
  label: string
  allow: boolean
  details: string[]
}

interface HandbookGroup {
  title: string
  items: HandbookItem[]
}

export interface HandbookPicture {
  groups: HandbookGroup[]
}

interface HandbookNavItem {
  id: string
  label: string
  group: "Roles" | "Service accounts" | "Public"
}

export interface HandbookData {
  roles: HandbookNavItem[]
  pictures: Record<string, HandbookPicture>
  error: string | null
}

export interface AuthorizationEvalResult {
  decision: "allow" | "deny" | "error"
  determiningPolicies: string[]
  policyTexts: string[]
  errors: string[]
  request: {
    principal: { type: string; id: string }
    action: { type: string; id: string }
    resource: { type: string; id: string }
    context: { nodeEnv: string; requestTime: string }
    entityCount: number
  }
}
