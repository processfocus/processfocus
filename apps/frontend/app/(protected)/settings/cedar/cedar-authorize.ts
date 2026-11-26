import "server-only"

import { randomUUID } from "node:crypto"
import type {
  AuthorizationAnswer,
  AuthorizationCall,
  CedarValueJson,
  EntityJson,
  TypeAndId,
} from "@cedar-policy/cedar-wasm"
import {
  policySetTextToParts,
  preparsePolicySet,
  preparseSchema,
  statefulIsAuthorized,
} from "@cedar-policy/cedar-wasm"
import type {
  AuthorizationEvalInput,
  AuthorizationEvalResult,
} from "./cedar-types"

const uid = (type: string, id: string): TypeAndId => ({ type, id })
const ent = (ref: TypeAndId): CedarValueJson => ({ __entity: ref })

// Cedar has no cache eviction API. Reuse one private slot, keyed by the complete
// artifacts, rather than retaining a new WASM policy/schema entry per request.
// Preparation and evaluation are synchronous: no other request can replace the
// slot between them. Decisions and request entities are never cached.
const ARTIFACT_SLOT = `dashboard-authorization-explorer:${randomUUID()}`
let preparedArtifacts: { policies: string; schema: string } | null = null

const authorizeWithArtifacts = (
  policies: string,
  schema: string,
  request: Omit<AuthorizationCall, "policies" | "schema">,
): AuthorizationAnswer => {
  if (
    preparedArtifacts?.policies !== policies ||
    preparedArtifacts.schema !== schema
  ) {
    preparedArtifacts = null
    const policyResult = preparsePolicySet(ARTIFACT_SLOT, {
      staticPolicies: policies,
    })
    if (policyResult.type === "failure") {
      return { ...policyResult, warnings: [] }
    }
    const schemaResult = preparseSchema(ARTIFACT_SLOT, schema)
    if (schemaResult.type === "failure") {
      return { ...schemaResult, warnings: [] }
    }
    preparedArtifacts = { policies, schema }
  }
  return statefulIsAuthorized({
    ...request,
    preparsedPolicySetId: ARTIFACT_SLOT,
    preparsedSchemaName: ARTIFACT_SLOT,
  })
}

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
    entities.push({
      uid: principalUid,
      attrs: { todoId: input.principal.id },
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
  context: {
    nodeEnv: "unknown",
    requestTime: "",
    weekday: "",
    runtimeMode: "unknown",
    stage: "",
    environment: "",
  },
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
  const weekday = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
  })
    .format(now)
    .toLowerCase()
  const context: Record<string, CedarValueJson> = {
    requestTime: { __extn: { fn: "datetime", arg: requestTime } },
    weekday,
    nodeEnv: process.env["NODE_ENV"] ?? "development",
    runtimeMode:
      process.env["PF_RUNTIME_MODE"] === "local" ||
      process.env["PF_RUNTIME_MODE"] === "deployed"
        ? process.env["PF_RUNTIME_MODE"]
        : "unknown",
    stage: process.env["PF_STAGE"] ?? "",
    environment: process.env["PF_ENV"] ?? "",
    ...(input.completionContext
      ? {
          todoId: input.completionContext.todoId,
          ...(input.completionContext.assignedTo
            ? {
                assignedTo: ent(
                  uid("PF::ProviderUser", input.completionContext.assignedTo),
                ),
              }
            : {}),
        }
      : {}),
  }
  const entities = buildEntities(input)
  const request = {
    principal: input.principal,
    action: { type: "PF::Action", id: input.action },
    resource: input.resource,
    context: {
      nodeEnv: String(context["nodeEnv"]),
      runtimeMode: String(context["runtimeMode"]),
      stage: String(context["stage"]),
      environment: String(context["environment"]),
      requestTime,
      weekday,
      ...input.completionContext,
    },
    entityCount: entities.length,
  }

  const answer = authorizeWithArtifacts(policies, schema, {
    principal: uid(input.principal.type, input.principal.id),
    action: uid("PF::Action", input.action),
    resource: uid(input.resource.type, input.resource.id),
    context,
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
