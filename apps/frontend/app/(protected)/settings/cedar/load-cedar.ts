import "server-only"

import { schemaToJson } from "@cedar-policy/cedar-wasm"
import { getFrontendJwt } from "@pf/auth-session"
import type {
  AuthorizationAction,
  AuthorizationCedar,
  AuthorizationEntityType,
  ResourceAttrControl,
} from "./cedar-types"
import { fetchCedarPolicies } from "@/lib/graphql/queries"
import { createServerGraphqlClient } from "@/lib/graphql/server-client"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const qualify = (namespace: string, name: string): string =>
  name.includes("::") ? name : `${namespace}::${name}`

const parseAttr = (
  namespace: string,
  name: string,
  spec: unknown,
): ResourceAttrControl | null => {
  if (!isRecord(spec)) return null
  const required = spec["required"] !== false
  const typeName = spec["type"]
  if (typeName === "Boolean" || typeName === "Bool") {
    return { control: "boolean", name, required }
  }
  if (typeName === "String" || typeName === "Long") {
    return { control: "string", name, required }
  }
  if (typeName === "Entity" || typeName === "EntityOrCommon") {
    const entityName = spec["name"]
    if (typeof entityName !== "string") return null
    if (entityName === "Bool" || entityName === "Boolean") {
      return { control: "boolean", name, required }
    }
    if (
      entityName === "String" ||
      entityName === "Long" ||
      entityName === "datetime"
    ) {
      return { control: "string", name, required }
    }
    const entityType = qualify(namespace, entityName)
    if (entityType === `${namespace}::ProviderUser`) {
      return { control: "principal", name, required }
    }
    if (entityType === `${namespace}::Role`) {
      return { control: "role", name, required }
    }
    return { control: "related", name, required, entityType }
  }
  if (typeName === "Set" && isRecord(spec["element"])) {
    const element = spec["element"]
    const elementType = element["type"]
    const elementName = element["name"]
    if (
      (elementType === "Entity" || elementType === "EntityOrCommon") &&
      typeof elementName === "string" &&
      qualify(namespace, elementName) === `${namespace}::Role`
    ) {
      return { control: "roleSet", name, required }
    }
  }
  return null
}

const parseEntity = (
  namespace: string,
  shortName: string,
  spec: unknown,
): AuthorizationEntityType | null => {
  if (!isRecord(spec)) return null
  const memberOfRaw = spec["memberOfTypes"]
  const memberOf = Array.isArray(memberOfRaw)
    ? memberOfRaw
        .filter((item) => typeof item === "string")
        .map((item) => qualify(namespace, item))
    : []
  const shape = spec["shape"]
  const attributes: ResourceAttrControl[] = []
  if (isRecord(shape) && isRecord(shape["attributes"])) {
    for (const [name, attrSpec] of Object.entries(shape["attributes"])) {
      const parsed = parseAttr(namespace, name, attrSpec)
      if (parsed) attributes.push(parsed)
    }
  }
  return {
    typeName: qualify(namespace, shortName),
    memberOf,
    attributes,
  }
}

export const loadAuthorizationCedar = async (): Promise<AuthorizationCedar> => {
  const token = getFrontendJwt()
  if (!token) {
    return {
      actions: [],
      entities: [],
      policiesText: "",
      schemaText: "",
      loadError: "FRONTEND_JWT_TOKEN is not configured",
    }
  }

  try {
    const client = createServerGraphqlClient(token)
    const data = await fetchCedarPolicies(client)
    if (!data) {
      return {
        actions: [],
        entities: [],
        policiesText: "",
        schemaText: "",
        loadError: "cedarPolicies query returned no data",
      }
    }

    const parsed = schemaToJson(data.schema)
    if (parsed.type === "failure") {
      return {
        actions: [],
        entities: [],
        policiesText: data.policies.join("\n\n"),
        schemaText: data.schema,
        loadError: parsed.errors.map((error) => error.message).join("; "),
      }
    }

    const actions: AuthorizationAction[] = []
    const entities: AuthorizationEntityType[] = []
    for (const [namespace, definition] of Object.entries(parsed.json)) {
      for (const [id, action] of Object.entries(definition.actions)) {
        const appliesTo = action.appliesTo
        actions.push({
          id,
          principalTypes: (appliesTo?.principalTypes ?? []).map((type) =>
            type.includes("::") ? type : `${namespace}::${type}`,
          ),
          resourceTypes: (appliesTo?.resourceTypes ?? []).map((type) =>
            type.includes("::") ? type : `${namespace}::${type}`,
          ),
        })
      }
      for (const [shortName, entitySpec] of Object.entries(
        definition.entityTypes,
      )) {
        const entity = parseEntity(namespace, shortName, entitySpec)
        if (entity) entities.push(entity)
      }
    }

    return {
      actions,
      entities,
      policiesText: data.policies.join("\n\n"),
      schemaText: data.schema,
      loadError: null,
    }
  } catch (error) {
    return {
      actions: [],
      entities: [],
      policiesText: "",
      schemaText: "",
      loadError:
        error instanceof Error ? error.message : "Failed to load Cedar schema",
    }
  }
}
