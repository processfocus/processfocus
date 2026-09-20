"use client"

import { useEffect, useMemo, useState } from "react"
import { genericPrincipalId } from "./cedar-helpers"
import type {
  AuthorizationCedar,
  AuthorizationEntityType,
  AuthorizationEvalResult,
  ResourceAttrControl,
} from "./cedar-types"
import { evaluateAuthorizationCedar } from "./evaluate-cedar"
import { useGraphqlClient } from "@/lib/graphql/client-provider"
import { fetchAllUsers } from "@/lib/graphql/settings-queries"
import { fetchAllRoles, fetchUserDetail } from "@/lib/graphql/user-queries"
import { cn } from "@/lib/utils"

const SERVICE_ACCOUNTS = ["frontend", "scheduler"] as const

const defaultAttrValues = (
  entity: AuthorizationEntityType | undefined,
): Record<string, boolean | string> => {
  const values: Record<string, boolean | string> = {}
  for (const attr of entity?.attributes ?? []) {
    if (attr.control === "boolean") values[attr.name] = attr.required
    else if (attr.control === "string") values[attr.name] = ""
    else if (
      attr.control === "principal" ||
      attr.control === "role" ||
      attr.control === "roleSet"
    ) {
      values[attr.name] = true
    }
  }
  return values
}

const underOrg = (orgUnitId: string, rest: string): string => {
  if (orgUnitId === "/" || orgUnitId === "") return `/${rest}`
  return `${orgUnitId.replace(/\/$/, "")}/${rest}`
}

const defaultResourceId = (
  type: string,
  orgUnitId: string,
  rolePath: string,
) => {
  switch (type) {
    case "PF::Application":
      return "default"
    case "PF::Role":
      return rolePath || "/Administrator"
    case "PF::GraphQLField":
      return "Query.org"
    case "PF::ProviderUser":
      return "other@example.com"
    case "PF::Step":
      return underOrg(orgUnitId, "prototype/Start")
    case "PF::Todo":
      return underOrg(orgUnitId, "prototype/todo-1")
    case "PF::Execution":
      return underOrg(orgUnitId, "prototype/exec-1")
    case "PF::List":
      return underOrg(orgUnitId, "prototype-list")
    case "PF::File":
      return underOrg(orgUnitId, "file-1")
    case "PF::FormField":
      return underOrg(orgUnitId, "prototype/Start/prototype")
    default:
      return "prototype"
  }
}

type PrincipalChoice =
  | { kind: "user"; userId: string; email: string }
  | { kind: "role"; path: string }
  | { kind: "service"; id: string }
  | { kind: "public-link" }

export function AuthorizationExplorer({
  cedar,
}: {
  cedar: AuthorizationCedar
}) {
  const client = useGraphqlClient()

  const [roles, setRoles] = useState<
    { id: string; name: string; path: string }[]
  >([])
  const [users, setUsers] = useState<
    { userId: string; email: string; name: string | null }[]
  >([])
  const [rolesError, setRolesError] = useState<string | null>(null)
  const [userRolePaths, setUserRolePaths] = useState<string[]>([])
  const [principal, setPrincipal] = useState<PrincipalChoice>({
    kind: "service",
    id: "frontend",
  })
  const [actionId, setActionId] = useState(cedar.actions[0]?.id ?? "complete")
  const action = cedar.actions.find((item) => item.id === actionId)
  const resourceTypes = action?.resourceTypes ?? []
  const [resourceType, setResourceType] = useState(
    resourceTypes[0] ?? "PF::Application",
  )
  const [resourceId, setResourceId] = useState("default")
  const entity = cedar.entities.find((item) => item.typeName === resourceType)
  const [attrValues, setAttrValues] = useState<
    Record<string, boolean | string>
  >(() => defaultAttrValues(entity))
  const [result, setResult] = useState<AuthorizationEvalResult | null>(null)
  const [evaluating, setEvaluating] = useState(false)

  useEffect(() => {
    let cancelled = false
    Promise.all([fetchAllRoles(client), fetchAllUsers(client, 1, 10)])
      .then(([roleItems, userPage]) => {
        if (cancelled) return
        setRoles(
          roleItems.map((item) => ({
            id: item.id,
            name: item.name,
            path: item.path,
          })),
        )
        setUsers(
          userPage.items
            .filter((item) => item.isProviderUser && item.providerUserEmail)
            .map((item) => ({
              userId: item.id,
              email: item.providerUserEmail ?? "",
              name: item.providerUserName,
            })),
        )
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setRolesError(
            error instanceof Error ? error.message : "Could not load org data",
          )
        }
      })
    return () => {
      cancelled = true
    }
  }, [client])

  useEffect(() => {
    if (principal.kind !== "user") {
      setUserRolePaths([])
      return
    }
    let cancelled = false
    fetchUserDetail(client, principal.userId)
      .then((detail) => {
        if (cancelled) return
        const roleIds = detail?.providerUser?.roleIds ?? []
        setUserRolePaths(
          roles
            .filter((role) => roleIds.includes(role.id))
            .map((role) => role.path),
        )
      })
      .catch(() => {
        if (!cancelled) setUserRolePaths([])
      })
    return () => {
      cancelled = true
    }
  }, [client, principal, roles])

  const selectedRolePath = useMemo(() => {
    if (principal.kind === "role") return principal.path
    if (principal.kind === "user")
      return userRolePaths[0] ?? roles[0]?.path ?? "/Employee"
    return roles[0]?.path ?? "/Employee"
  }, [principal, roles, userRolePaths])

  const orgUnitId = useMemo(() => {
    const parts = selectedRolePath.split("/").filter(Boolean)
    if (parts.length <= 1) return "/"
    return `/${parts.slice(0, -1).join("/")}`
  }, [selectedRolePath])

  useEffect(() => {
    const allowed = action?.resourceTypes ?? []
    if (!allowed.includes(resourceType)) {
      const next = allowed[0] ?? "PF::Application"
      setResourceType(next)
      setResourceId(defaultResourceId(next, orgUnitId, selectedRolePath))
    }
  }, [action, orgUnitId, resourceType, selectedRolePath])

  useEffect(() => {
    setAttrValues(defaultAttrValues(entity))
  }, [entity])

  const request = useMemo(() => {
    const rolesForPrincipal =
      principal.kind === "user"
        ? userRolePaths
        : principal.kind === "role"
          ? [principal.path]
          : principal.kind === "service"
            ? [selectedRolePath]
            : []

    const principalUid =
      principal.kind === "user"
        ? { type: "PF::ProviderUser", id: principal.email }
        : principal.kind === "role"
          ? {
              type: "PF::ProviderUser",
              id: genericPrincipalId(principal.path),
            }
          : principal.kind === "service"
            ? { type: "PF::ServiceAccount", id: principal.id }
            : { type: "PF::PublicLink", id: "prototype-link" }

    return {
      principal: principalUid,
      roles: rolesForPrincipal,
      orgUnitId,
      action: actionId,
      resource: { type: resourceType, id: resourceId },
      processPath: null,
      entity: entity ?? null,
      attrValues,
    }
  }, [
    actionId,
    attrValues,
    entity,
    orgUnitId,
    principal,
    resourceId,
    resourceType,
    selectedRolePath,
    userRolePaths,
  ])

  useEffect(() => {
    let cancelled = false
    setEvaluating(true)
    evaluateAuthorizationCedar(request)
      .then((next) => {
        if (!cancelled) setResult(next)
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setResult({
            decision: "error",
            determiningPolicies: [],
            policyTexts: [],
            errors: [
              error instanceof Error ? error.message : "Evaluation failed",
            ],
            request: {
              principal: request.principal,
              action: { type: "PF::Action", id: request.action },
              resource: request.resource,
              context: { nodeEnv: "unknown", requestTime: "" },
              entityCount: 0,
            },
          })
        }
      })
      .finally(() => {
        if (!cancelled) setEvaluating(false)
      })
    return () => {
      cancelled = true
    }
  }, [request])

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 pb-24">
      <header className="text-center">
        <p className="text-xs font-semibold tracking-widest text-slate-500 uppercase">
          Live Cedar
        </p>
        <h2 className="text-2xl font-bold text-slate-900 dark:text-slate-50">
          isAuthorized
        </h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          Principal, action, and resource from this org. Decision is cedar-wasm
          against the combined policy set.
        </p>
      </header>

      {cedar.loadError ? (
        <p className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
          {cedar.loadError}
        </p>
      ) : null}
      {rolesError ? (
        <p className="text-center text-xs text-amber-700">{rolesError}</p>
      ) : null}

      <div className="grid gap-3 rounded-2xl border border-slate-200 p-4 sm:grid-cols-3 dark:border-slate-700">
        <label className="block text-xs font-semibold tracking-wide text-slate-500 uppercase">
          Principal
          <select
            value={principalKey(principal)}
            onChange={(event) =>
              setPrincipal(parsePrincipal(event.target.value, users))
            }
            className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-2 text-sm font-normal normal-case dark:border-slate-600 dark:bg-slate-900"
          >
            <optgroup label="User">
              {users.map((user) => (
                <option key={user.userId} value={`user:${user.userId}`}>
                  {user.name ? `${user.name} (${user.email})` : user.email}
                </option>
              ))}
            </optgroup>
            <optgroup label="Roles">
              {roles.map((role) => (
                <option key={role.path} value={`role:${role.path}`}>
                  {role.path}
                </option>
              ))}
            </optgroup>
            <optgroup label="Service account">
              {SERVICE_ACCOUNTS.map((id) => (
                <option key={id} value={`service:${id}`}>
                  PF::ServiceAccount::{id}
                </option>
              ))}
            </optgroup>
            <option value="public-link">PF::PublicLink::prototype-link</option>
          </select>
        </label>

        <label className="block text-xs font-semibold tracking-wide text-slate-500 uppercase">
          Action
          <select
            value={actionId}
            onChange={(event) => setActionId(event.target.value)}
            className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-2 text-sm font-normal normal-case dark:border-slate-600 dark:bg-slate-900"
          >
            {cedar.actions.map((item) => (
              <option key={item.id} value={item.id}>
                {item.id}
              </option>
            ))}
          </select>
        </label>

        <label className="block text-xs font-semibold tracking-wide text-slate-500 uppercase">
          Resource
          <select
            value={resourceType}
            onChange={(event) => {
              const next = event.target.value
              setResourceType(next)
              setResourceId(
                defaultResourceId(next, orgUnitId, selectedRolePath),
              )
            }}
            className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-2 text-sm font-normal normal-case dark:border-slate-600 dark:bg-slate-900"
          >
            {resourceTypes.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
          <input
            value={resourceId}
            onChange={(event) => setResourceId(event.target.value)}
            className="mt-2 w-full rounded-md border border-slate-300 bg-white px-2 py-2 font-mono text-xs font-normal normal-case dark:border-slate-600 dark:bg-slate-900"
          />
        </label>
      </div>

      <AttrPanel
        attributes={entity?.attributes ?? []}
        values={attrValues}
        onChange={(name, value) =>
          setAttrValues((current) => ({ ...current, [name]: value }))
        }
      />

      <div
        className={cn(
          "mx-auto flex size-40 items-center justify-center rounded-full border-8 text-2xl font-black tracking-widest uppercase",
          result?.decision === "allow"
            ? "border-emerald-600 text-emerald-700 dark:border-emerald-400 dark:text-emerald-300"
            : result?.decision === "deny"
              ? "border-rose-600 text-rose-700 dark:border-rose-400 dark:text-rose-300"
              : "border-slate-400 text-slate-500",
        )}
      >
        {evaluating ? "…" : (result?.decision ?? "—")}
      </div>

      <div className="rounded-lg bg-slate-50 p-4 dark:bg-slate-900/60">
        <p className="text-center font-mono text-xs text-slate-500">
          {request.principal.type}::{request.principal.id} → PF::Action::
          {request.action} → {request.resource.type}::{request.resource.id}
        </p>
        {result?.determiningPolicies.length ? (
          <div className="mt-3">
            <p className="text-xs font-semibold tracking-widest text-slate-500 uppercase">
              Determining policies
            </p>
            <p className="mt-1 font-mono text-xs text-slate-600">
              {result.determiningPolicies.join(", ")}
            </p>
            {result.policyTexts.map((text) => (
              <pre
                key={text}
                className="mt-2 overflow-auto rounded bg-white p-3 text-[11px] leading-4 text-slate-700 dark:bg-slate-950 dark:text-slate-300"
              >
                {text}
              </pre>
            ))}
          </div>
        ) : result?.decision === "deny" ? (
          <p className="mt-3 text-center text-sm text-slate-600">
            No permit matched. Default deny.
          </p>
        ) : null}
        {result?.errors.length ? (
          <ul className="mt-3 list-disc pl-5 text-sm text-rose-700">
            {result.errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        ) : null}
      </div>

      <pre className="overflow-auto text-[11px] leading-4 text-slate-400">
        {JSON.stringify(result, null, 2)}
      </pre>
    </div>
  )
}

function attrLabel(attr: ResourceAttrControl): string {
  if (attr.control === "principal") return `${attr.name} is principal`
  if (attr.control === "role") return `${attr.name} is principal's role`
  if (attr.control === "roleSet")
    return `${attr.name} contains principal's role`
  return attr.name
}

function AttrPanel({
  attributes,
  values,
  onChange,
}: {
  attributes: ResourceAttrControl[]
  values: Record<string, boolean | string>
  onChange: (name: string, value: boolean | string) => void
}) {
  const visible = attributes.filter((attr) => attr.control !== "related")
  if (visible.length === 0) return null
  return (
    <div className="flex flex-wrap gap-3 text-sm text-slate-700 dark:text-slate-300">
      {visible.map((attr) => {
        const raw = values[attr.name]
        return attr.control === "string" ? (
          <label key={attr.name} className="inline-flex items-center gap-2">
            {attr.name}
            <input
              value={typeof raw === "string" ? raw : ""}
              onChange={(event) => onChange(attr.name, event.target.value)}
              className="rounded border border-slate-300 bg-white px-2 py-1 font-mono text-xs dark:border-slate-600 dark:bg-slate-900"
            />
          </label>
        ) : (
          <Toggle
            key={attr.name}
            label={attrLabel(attr)}
            checked={values[attr.name] === true}
            onChange={(value) => onChange(attr.name, value)}
          />
        )
      })}
    </div>
  )
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <label className="inline-flex items-center gap-2">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      {label}
    </label>
  )
}

function principalKey(principal: PrincipalChoice): string {
  if (principal.kind === "user") return `user:${principal.userId}`
  if (principal.kind === "role") return `role:${principal.path}`
  if (principal.kind === "service") return `service:${principal.id}`
  return "public-link"
}

function parsePrincipal(
  value: string,
  users: { userId: string; email: string }[],
): PrincipalChoice {
  if (value === "public-link") return { kind: "public-link" }
  if (value.startsWith("role:")) return { kind: "role", path: value.slice(5) }
  if (value.startsWith("service:"))
    return { kind: "service", id: value.slice(8) }
  if (value.startsWith("user:")) {
    const userId = value.slice(5)
    const user = users.find((item) => item.userId === userId)
    if (user) return { kind: "user", userId: user.userId, email: user.email }
  }
  return { kind: "public-link" }
}
