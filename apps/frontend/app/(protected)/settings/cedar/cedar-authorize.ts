import "server-only"

import type {
  CedarValueJson,
  EntityJson,
  TypeAndId,
} from "@cedar-policy/cedar-wasm"
import { isAuthorized, policySetTextToParts } from "@cedar-policy/cedar-wasm"
import type {
  AuthorizationEvalInput,
  AuthorizationEvalResult,
} from "./cedar-types"

const uid = (type: string, id: string): TypeAndId => ({ type, id })
const ent = (ref: TypeAndId): CedarValueJson => ({ __entity: ref })

const formatLocalTimeAsUtc = (date: Date): string => {
  const pad2 = (n: number) => String(n).padStart(2, "0")
  const pad3 = (n: number) => String(n).padStart(3, "0")
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}.${pad3(date.getMilliseconds())}Z`
}

const roleRef = (path: string) => uid("PF::Role", path)
const orgUnitRef = (id: string) => uid("PF::OrgUnit", id)

const buildEntities = (input: AuthorizationEvalInput): EntityJson[] => {
  const entities: EntityJson[] = []
  const principalUid = uid(input.principal.type, input.principal.id)

  const extraRolePaths = Object.values(input.attrValues).filter(
    (value): value is string =>
      typeof value === "string" && value.startsWith("/"),
  )
  const allRolePaths = [...new Set([...input.roles, ...extraRolePaths])]
  for (const path of allRolePaths) {
    entities.push({ uid: roleRef(path), attrs: {}, parents: [] })
  }

  entities.push({
    uid: orgUnitRef(input.orgUnitId),
    attrs: { name: input.orgUnitId },
    parents: [],
  })

  if (input.principal.type === "PF::ProviderUser") {
    entities.push({
      uid: principalUid,
      attrs: {
        roles: input.roles.map((path) => ent(roleRef(path))),
        orgUnit: ent(orgUnitRef(input.orgUnitId)),
      },
      parents: [orgUnitRef(input.orgUnitId), ...input.roles.map(roleRef)],
    })
  } else if (input.principal.type === "PF::ServiceAccount") {
    entities.push({
      uid: principalUid,
      attrs: {
        roles: input.roles.map((path) => ent(roleRef(path))),
      },
      parents: [],
    })
  } else if (input.principal.type === "PF::PublicLink") {
    const todo = uid("PF::Todo", input.resource.id)
    entities.push({
      uid: principalUid,
      attrs: { todo: ent(todo) },
      parents: [],
    })
  }

  const resourceUid = uid(input.resource.type, input.resource.id)
  const orgPrefix =
    input.orgUnitId === "/" || input.orgUnitId === ""
      ? ""
      : input.orgUnitId.replace(/\/$/, "")
  const process = uid(
    "PF::Process",
    input.processPath ?? `${orgPrefix}/prototype`,
  )
  const step = uid(
    "PF::Step",
    input.resource.type.endsWith("::Step")
      ? input.resource.id
      : `${orgPrefix}/prototype/Start`,
  )
  const otherUser = uid("PF::ProviderUser", "someone-else@prototype.local")
  const firstRole = input.roles[0]

  const relatedRef = (entityType: string): TypeAndId => {
    if (entityType.endsWith("::Process")) return process
    if (entityType.endsWith("::Step")) return step
    if (entityType.endsWith("::OrgUnit")) return orgUnitRef(input.orgUnitId)
    if (entityType.endsWith("::ProviderUser")) return principalUid
    if (entityType.endsWith("::Role"))
      return firstRole ? roleRef(firstRole) : uid(entityType, "prototype")
    if (entityType.endsWith("::Todo"))
      return uid("PF::Todo", `${input.orgUnitId}/prototype/todo-1`)
    return uid(entityType, "prototype")
  }

  entities.push({
    uid: process,
    attrs: {},
    parents: [orgUnitRef(input.orgUnitId)],
  })
  entities.push({
    uid: step,
    attrs: { startsProcess: false, embedded: false },
    parents: [process],
  })
  entities.push({
    uid: otherUser,
    attrs: {
      roles: [],
      orgUnit: ent(orgUnitRef(input.orgUnitId)),
    },
    parents: [orgUnitRef(input.orgUnitId)],
  })

  const attrs: Record<string, CedarValueJson> = {}
  for (const attr of input.entity?.attributes ?? []) {
    const value = input.attrValues[attr.name]
    if (attr.control === "boolean") {
      attrs[attr.name] = value === true
    } else if (attr.control === "string") {
      const text = typeof value === "string" ? value : ""
      if (text !== "") attrs[attr.name] = text
      else if (attr.required) attrs[attr.name] = "prototype"
    } else if (attr.control === "principal") {
      if (value === true && input.principal.type === "PF::ProviderUser") {
        attrs[attr.name] = ent(principalUid)
      } else if (value === false || attr.required) {
        attrs[attr.name] = ent(otherUser)
      }
    } else if (attr.control === "role") {
      if (typeof value === "string" && value !== "") {
        attrs[attr.name] = ent(roleRef(value))
      } else if (value === true && firstRole) {
        attrs[attr.name] = ent(roleRef(firstRole))
      }
    } else if (attr.control === "roleSet") {
      if (typeof value === "string" && value !== "") {
        attrs[attr.name] = [ent(roleRef(value))]
      } else if (value === true) {
        attrs[attr.name] = input.roles.map((path) => ent(roleRef(path)))
      } else if (attr.required) {
        attrs[attr.name] = []
      }
    } else {
      attrs[attr.name] = ent(relatedRef(attr.entityType))
    }
  }

  const parents = (input.entity?.memberOf ?? []).map((type) => relatedRef(type))
  entities.push({ uid: resourceUid, attrs, parents })

  return dedupeEntities(entities)
}

const dedupeEntities = (entities: EntityJson[]): EntityJson[] => {
  const seen = new Map<string, EntityJson>()
  for (const entity of entities) {
    const key =
      "__entity" in entity.uid
        ? `${entity.uid.__entity.type}::${entity.uid.__entity.id}`
        : `${entity.uid.type}::${entity.uid.id}`
    seen.set(key, entity)
  }
  return [...seen.values()]
}

const emptyRequest = (input: AuthorizationEvalInput) => ({
  principal: input.principal,
  action: { type: "PF::Action", id: input.action },
  resource: input.resource,
  context: { nodeEnv: "unknown", requestTime: "" },
  entityCount: 0,
})

export const evaluateWithArtifacts = (
  policies: string,
  schema: string,
  input: AuthorizationEvalInput,
  includePolicyText: boolean,
): AuthorizationEvalResult => {
  const now = new Date()
  const requestTime = formatLocalTimeAsUtc(now)
  const context: Record<string, CedarValueJson> = {
    requestTime: { __extn: { fn: "datetime", arg: requestTime } },
    nodeEnv: process.env["NODE_ENV"] ?? "development",
  }
  const entities = buildEntities(input)
  const request = {
    principal: input.principal,
    action: { type: "PF::Action", id: input.action },
    resource: input.resource,
    context: {
      nodeEnv: String(context["nodeEnv"]),
      requestTime,
    },
    entityCount: entities.length,
  }

  const answer = isAuthorized({
    principal: uid(input.principal.type, input.principal.id),
    action: uid("PF::Action", input.action),
    resource: uid(input.resource.type, input.resource.id),
    context,
    schema,
    policies: { staticPolicies: policies },
    entities,
    validateRequest: true,
  })

  if (answer.type === "failure") {
    return {
      decision: "error",
      determiningPolicies: [],
      policyTexts: [],
      errors: answer.errors.map((error) => error.message),
      request,
    }
  }

  const determiningPolicies = answer.response.diagnostics.reason
  let policyTexts: string[] = []
  if (includePolicyText) {
    const parts = policySetTextToParts(policies)
    policyTexts =
      parts.type === "success"
        ? determiningPolicies.flatMap((policyId) => {
            const match = /^policy(\d+)$/.exec(policyId)
            if (!match) return []
            const index = Number(match[1])
            const text = parts.policies[index]
            return text ? [text] : []
          })
        : []
  }

  return {
    decision: answer.response.decision,
    determiningPolicies,
    policyTexts,
    errors: answer.response.diagnostics.errors.map(
      (error) => `${error.policyId}: ${error.error.message}`,
    ),
    request,
  }
}

export const emptyEvalResult = (
  input: AuthorizationEvalInput,
  errors: string[],
): AuthorizationEvalResult => ({
  decision: "error",
  determiningPolicies: [],
  policyTexts: [],
  errors,
  request: emptyRequest(input),
})
