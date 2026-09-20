import "server-only"

import { getFrontendJwt } from "@pf/auth-session"
import { evaluateWithArtifacts } from "./cedar-authorize"
import { genericPrincipalId, orgUnitFromRole } from "./cedar-helpers"
import type {
  AuthorizationCedar,
  AuthorizationEvalInput,
  HandbookData,
  HandbookPicture,
} from "./cedar-types"
import { fetchAuthorizationProcesses } from "./org-data"
import { getSessionWithTokenAndExpiry } from "@/lib/auth/session"
import { fetchCedarPolicies } from "@/lib/graphql/queries"
import { createServerGraphqlClient } from "@/lib/graphql/server-client"
import { fetchAllRoles } from "@/lib/graphql/user-queries"

const ADMIN_ACTIONS = [
  { id: "administerUsers", label: "Manage users and roles" },
  { id: "administerOAuthProviders", label: "Manage sign-in providers" },
  { id: "showProcessState", label: "Inspect process state" },
  { id: "viewAuthorization", label: "View authorisation" },
  { id: "administerProjectStageConfig", label: "Manage project stage config" },
  { id: "databaseShell", label: "Database shell" },
] as const

type HandbookPrincipal =
  | { kind: "role"; path: string }
  | { kind: "service"; id: string }
  | { kind: "public-link" }

const principalInput = (
  cedar: AuthorizationCedar,
  who: HandbookPrincipal,
  action: string,
  resourceType: string,
  resourceId: string,
  attrValues: Record<string, boolean | string>,
  processPath: string | null = null,
): AuthorizationEvalInput => {
  const principal =
    who.kind === "role"
      ? { type: "PF::ProviderUser", id: genericPrincipalId(who.path) }
      : who.kind === "service"
        ? { type: "PF::ServiceAccount", id: who.id }
        : { type: "PF::PublicLink", id: "prototype-link" }
  return {
    principal,
    roles: who.kind === "role" ? [who.path] : [],
    orgUnitId: who.kind === "role" ? orgUnitFromRole(who.path) : "/",
    action,
    resource: { type: resourceType, id: resourceId },
    processPath,
    entity:
      cedar.entities.find((item) => item.typeName === resourceType) ?? null,
    attrValues,
  }
}

const isAllow = (
  policies: string,
  schema: string,
  input: AuthorizationEvalInput,
): boolean =>
  evaluateWithArtifacts(policies, schema, input, false).decision === "allow"

const pictureForPrincipal = (
  cedar: AuthorizationCedar,
  policies: string,
  schema: string,
  who: HandbookPrincipal,
  otherRolePath: string | null,
  processes: {
    name: string
    path: string
    startStepPath: string
    startRolePath: string | null
    startEmbedded: boolean
  }[],
): HandbookPicture => {
  const check = (
    action: string,
    resourceType: string,
    resourceId: string,
    attrValues: Record<string, boolean | string>,
    processPath: string | null = null,
  ) =>
    isAllow(
      policies,
      schema,
      principalInput(
        cedar,
        who,
        action,
        resourceType,
        resourceId,
        attrValues,
        processPath,
      ),
    )

  const started = processes.filter((process) =>
    check(
      "complete",
      "PF::Step",
      process.startStepPath,
      {
        startsProcess: true,
        embedded: process.startEmbedded,
        ...(process.startRolePath
          ? { role: process.startRolePath }
          : { role: false }),
      },
      process.path,
    ),
  )
  const rolelessStarts = processes.filter(
    (process) =>
      process.startRolePath === null &&
      check(
        "complete",
        "PF::Step",
        process.startStepPath,
        { startsProcess: true, embedded: process.startEmbedded, role: false },
        process.path,
      ),
  )
  return {
    groups: [
      {
        title: "Sign-in",
        items: [
          {
            label: "Sign in",
            allow: check("login", "PF::Application", "default", {}),
            details: [],
          },
          {
            label: "Switch to a role they hold",
            allow:
              who.kind === "role" &&
              check("requestRole", "PF::Role", who.path, {}),
            details: [],
          },
          {
            label: "Switch to any role",
            allow: otherRolePath
              ? check("requestRole", "PF::Role", otherRolePath, {})
              : false,
            details: [],
          },
        ],
      },
      {
        title: "Processes",
        items: [
          {
            label:
              who.kind === "service" && who.id === "frontend"
                ? "Start an embedded process"
                : "Start a process",
            allow: started.length > 0,
            details: started.map((process) => process.name),
          },
          {
            label: "Start a role-less process",
            allow: rolelessStarts.length > 0,
            details: rolelessStarts.map((process) => process.name),
          },
          {
            label: "Complete the linked todo",
            allow:
              who.kind === "public-link" &&
              check("complete", "PF::Todo", "handbook-todo", {
                role: false,
                assignedTo: false,
              }),
            details: [],
          },
          {
            label: "Complete a todo for their role",
            allow:
              who.kind === "role" &&
              check("complete", "PF::Todo", "handbook-todo", {
                role: true,
                assignedTo: true,
              }),
            details: [],
          },
          {
            label: "Complete a todo assigned to someone else",
            allow:
              who.kind === "role" &&
              check("complete", "PF::Todo", "handbook-todo-other", {
                role: true,
                assignedTo: false,
              }),
            details: [],
          },
        ],
      },
      {
        title: "Process executions",
        items: [
          {
            label: "View an execution they started",
            allow: check("view", "PF::Execution", "handbook-exec", {
              startedBy: true,
            }),
            details: [],
          },
          {
            label: "View any execution",
            allow: check("view", "PF::Execution", "handbook-exec-any", {
              startedBy: false,
            }),
            details: [],
          },
          {
            label: "Restart an execution they started",
            allow: check("restart", "PF::Execution", "handbook-exec", {
              startedBy: true,
            }),
            details: [],
          },
        ],
      },
      {
        title: "Lists",
        items: [
          {
            label: "View a list allowed for their role",
            allow: check("view", "PF::List", "handbook-list", { roles: true }),
            details: [],
          },
          {
            label: "View a list allowed for another role",
            allow: otherRolePath
              ? check("view", "PF::List", "handbook-list-other", {
                  roles: otherRolePath,
                })
              : false,
            details: [],
          },
          {
            label: "Update a list allowed for their role",
            allow: check("update", "PF::List", "handbook-list", {
              roles: true,
            }),
            details: [],
          },
        ],
      },
      {
        title: "Files",
        items: [
          {
            label: "Download their own file",
            allow: check("download", "PF::File", "handbook-file", {
              owner: true,
            }),
            details: [],
          },
          {
            label: "Download someone else's file",
            allow: check("download", "PF::File", "handbook-file-other", {
              owner: false,
            }),
            details: [],
          },
        ],
      },
      {
        title: "Admin",
        items: [
          ...ADMIN_ACTIONS.filter((item) =>
            cedar.actions.some((action) => action.id === item.id),
          ).map((item) => ({
            label: item.label,
            allow: check(item.id, "PF::Application", "default", {}),
            details: [],
          })),
          {
            label: "Act on behalf of another user",
            allow: check(
              "actOnBehalfOf",
              "PF::ProviderUser",
              "other@example.com",
              {},
            ),
            details: [],
          },
        ],
      },
    ],
  }
}

export const loadHandbookData = async (
  cedar: AuthorizationCedar,
): Promise<HandbookData> => {
  const session = await getSessionWithTokenAndExpiry()
  const frontendJwt = getFrontendJwt()
  if (!session) {
    return { roles: [], pictures: {}, error: "Not signed in" }
  }
  if (!frontendJwt) {
    return {
      roles: [],
      pictures: {},
      error: "FRONTEND_JWT_TOKEN is not configured",
    }
  }

  try {
    const userClient = createServerGraphqlClient(session.accessToken)
    const policyClient = createServerGraphqlClient(frontendJwt)
    const [roles, processes, cedarData] = await Promise.all([
      fetchAllRoles(userClient),
      fetchAuthorizationProcesses(userClient),
      fetchCedarPolicies(policyClient),
    ])

    if (!cedarData) {
      return {
        roles: [],
        pictures: {},
        error: "cedarPolicies query returned no data",
      }
    }

    const policies = cedarData.policies.join("\n\n")
    const pictures: Record<string, HandbookPicture> = {}
    const nav = [
      ...roles.map((role) => ({
        id: `role:${role.path}`,
        label: role.path,
        group: "Roles" as const,
      })),
      {
        id: "service:frontend",
        label: "frontend",
        group: "Service accounts" as const,
      },
      {
        id: "service:scheduler",
        label: "scheduler",
        group: "Service accounts" as const,
      },
      { id: "public-link", label: "Public link", group: "Public" as const },
    ]

    const principals: { id: string; who: HandbookPrincipal }[] = [
      ...roles.map((role) => ({
        id: `role:${role.path}`,
        who: { kind: "role" as const, path: role.path },
      })),
      { id: "service:frontend", who: { kind: "service", id: "frontend" } },
      { id: "service:scheduler", who: { kind: "service", id: "scheduler" } },
      { id: "public-link", who: { kind: "public-link" } },
    ]

    for (const item of principals) {
      const otherRole = roles.find(
        (role) => item.who.kind !== "role" || role.path !== item.who.path,
      )
      pictures[item.id] = pictureForPrincipal(
        cedar,
        policies,
        cedarData.schema,
        item.who,
        otherRole?.path ?? null,
        processes,
      )
    }

    return {
      roles: nav,
      pictures,
      error: null,
    }
  } catch (error) {
    return {
      roles: [],
      pictures: {},
      error:
        error instanceof Error ? error.message : "Failed to build handbook",
    }
  }
}
