import { Effect, type Schema } from "effect"
import type * as AST from "effect/SchemaAST"
import type { DirectedGraph } from "graphology"
import {
  type OAuthProviderConfig,
  type OAuthProviderName,
  type PasskeyProviderConfig,
  isAuthenticationConfig,
} from "@pf/auth-config"
import { FormFileInput, fieldInputAst } from "@pf/form-schema"
import {
  type Form,
  type GraphEdge,
  type GraphNode,
  type OrgUnit,
  type Organisation,
  Process,
  type SlaConfig,
  isDocumentStore,
  isForm,
  isInvitation,
  isOrgUnit,
  isProcess,
  isRole,
  normalizePath,
} from "@pf/process"
import type {
  ExtractedDocumentStoreData,
  ExtractedFlowData,
  ExtractedHolidayRuleData,
  ExtractedInvitationData,
  ExtractedOrgData,
  ExtractedOrgUnitData,
  ExtractedPhaseData,
  ExtractedProcessData,
  ExtractedRoleData,
  ExtractedRoleResponsibilityData,
  ExtractedSlaData,
  ExtractedStepData,
  ExtractedWeeklyScheduleData,
} from "./types"

/**
 * Walks an organisation and extracts all data needed for database storage.
 *
 * Since Organisation extends OrgUnit, this function treats the Organisation
 * as the root organizational unit (with type "organisation" and no parent)
 * and recursively extracts all descendant org units in a hierarchical structure.
 *
 * Timezone and startDayOfWeek are inherited from the root organisation to all child org units.
 */
export const walkOrganisation = (
  org: Organisation,
): Effect.Effect<ExtractedOrgData> =>
  Effect.gen(function* () {
    const name = org.name

    // Extract the organisation itself as the root org unit with all descendants
    // Organisation is an OrgUnit, so we can pass it directly to extractOrgUnitDataRecursive
    // Timezone and startDayOfWeek are passed down from the root organisation to all descendants
    const rootOrgUnit = yield* extractOrgUnitDataRecursive(
      org,
      undefined, // No parent - it's the root
      org.timeZone ?? "UTC", // Timezone inherited from root
      org.businessCalendar?.startDayOfWeek, // startDayOfWeek inherited from root
    )

    // Extract business calendar data from the Organisation (root level only)
    const orgUnitPath = normalizePath(org.node.path)
    const weeklySchedule = extractWeeklySchedule(org, orgUnitPath)
    const holidayRules = extractHolidayRules(org, orgUnitPath)

    return {
      name,
      rootOrgUnit,
      weeklySchedule,
      holidayRules,
    }
  })

/**
 * Extracts weekly schedule entries from an Organisation's businessCalendar.
 * Returns one entry per day that has scheduled hours (closed days are omitted).
 */
const extractWeeklySchedule = (
  org: Organisation,
  orgUnitPath: string,
): ExtractedWeeklyScheduleData[] => {
  if (!org.businessCalendar?.weeklySchedule) {
    return []
  }

  return org.businessCalendar.weeklySchedule.map((daySchedule) => ({
    orgUnitPath,
    dayOfWeek: daySchedule.day,
    timeRanges: daySchedule.ranges.map((range) => ({
      open: { hour: range.open.hour, minute: range.open.minute },
      close: { hour: range.close.hour, minute: range.close.minute },
    })),
  }))
}

/**
 * Extracts holiday rules from an Organisation's businessCalendar.
 * Stores the rule definition as JSON, not computed dates.
 */
const extractHolidayRules = (
  org: Organisation,
  orgUnitPath: string,
): ExtractedHolidayRuleData[] => {
  if (!org.businessCalendar?.holidays) {
    return []
  }

  return org.businessCalendar.holidays.map((holiday) => ({
    orgUnitPath,
    name: holiday.name,
    rule: holiday as unknown as Record<string, unknown>,
  }))
}

/**
 * Recursively extracts data from an organizational unit and its children.
 * Returns a hierarchical structure with the current org unit and its descendants.
 *
 * All paths are normalized with a leading slash for database storage.
 * Timezone and startDayOfWeek are inherited from the root organisation.
 */
const extractOrgUnitDataRecursive = (
  orgUnit: OrgUnit,
  parentPath: string | undefined,
  timezone: string,
  startDayOfWeek: number | undefined,
): Effect.Effect<ExtractedOrgUnitData> =>
  Effect.gen(function* () {
    const orgUnitPath = normalizePath(orgUnit.node.path)

    // Extract processes from this org unit
    const processes = yield* extractProcessesFromOrgUnit(orgUnit)

    // Extract roles from this org unit
    const roles = extractRolesFromOrgUnit(orgUnit, orgUnitPath)

    // Recursively extract child org units (inherit timezone and startDayOfWeek from root)
    const childOrgUnits = orgUnit.node.children.filter(isOrgUnit)

    const children = yield* Effect.forEach(
      childOrgUnits,
      (child) =>
        extractOrgUnitDataRecursive(
          child,
          orgUnitPath,
          timezone,
          startDayOfWeek,
        ),
      { concurrency: "unbounded" },
    )

    // Return current org unit with its children in hierarchical structure
    return {
      name: orgUnit.name,
      orgUnitLevel: orgUnit.type ?? "unit",
      path: orgUnitPath,
      parentOrgUnitPath: parentPath,
      acronym: orgUnit.acronym,
      timezone,
      startDayOfWeek,
      processes,
      roles,
      children,
    }
  })

/**
 * Extracts all processes from an organizational unit.
 */
const extractProcessesFromOrgUnit = (
  orgUnit: OrgUnit,
): Effect.Effect<ExtractedProcessData[]> =>
  Effect.gen(function* () {
    const children = orgUnit.node.children

    // Filter for Process instances
    const processes = children.filter(isProcess)

    if (processes.length === 0) {
      return []
    }

    // Extract each process data in parallel
    return yield* Effect.forEach(
      processes,
      (process) => extractProcessData(process),
      { concurrency: "unbounded" },
    )
  })

/**
 * Extracts all roles from an organizational unit.
 * orgUnitPath is already normalized.
 */
const extractRolesFromOrgUnit = (
  orgUnit: OrgUnit,
  orgUnitPath: string,
): ExtractedRoleData[] => {
  const children = orgUnit.node.children

  // Filter for Role instances
  const roles = children.filter(isRole)

  return roles.map((role) => ({
    orgUnitPath,
    name: role.name,
    path: normalizePath(role.node.path),
  }))
}

/**
 * Extracts phases from a process based on the phases used by its steps.
 * Order is 1-based, determined by first appearance in the steps.
 */
const extractPhasesFromProcess = (
  process: Process,
  graph: DirectedGraph<GraphNode, GraphEdge>,
): ExtractedPhaseData[] => {
  const processPath = normalizePath(process.node.path)
  const seenPhasePaths = new Set<string>()
  const phases: ExtractedPhaseData[] = []

  // Iterate through nodes to find phases in order of appearance
  const nodes = graph
    .nodes()
    .filter((nodeId: string) => !Process.isVirtualNode(nodeId))

  for (const nodeId of nodes) {
    const step = graph.getNodeAttributes(nodeId)
    const phase = step.props.phase
    const phasePath = phase ? normalizePath(phase.node.path) : undefined
    if (phase && phasePath && !seenPhasePaths.has(phasePath)) {
      seenPhasePaths.add(phasePath)
      phases.push({
        processPath,
        name: phase.name,
        path: phasePath,
        order: phases.length + 1,
      })
    }
  }

  return phases
}

/**
 * Extracts role responsibilities from a process.
 * Order is 1-based, determined by position in the responsibilities array.
 */
const extractResponsibilitiesFromProcess = (
  process: Process,
): ExtractedRoleResponsibilityData[] => {
  const responsibilities = process.props.responsibilities ?? []
  return responsibilities.map((resp, index) => ({
    processPath: normalizePath(process.node.path),
    rolePath: normalizePath(resp.role.node.path),
    responsibility: resp.responsibility,
    order: index + 1,
  }))
}

/**
 * Converts an SlaConfig to ExtractedSlaData.
 */
const extractSlaData = (
  sla: SlaConfig | undefined,
): ExtractedSlaData | undefined => {
  if (!sla) return undefined
  return {
    value: sla.value,
    unit: sla.unit,
    warningAt: sla.warningAt,
  }
}

/**
 * Extracts all data from a single process.
 * All paths are normalized with a leading slash for database storage.
 */
const extractProcessData = (
  process: Process,
): Effect.Effect<ExtractedProcessData> =>
  Effect.gen(function* () {
    const graph = process.getGraph() as DirectedGraph<GraphNode, GraphEdge>
    const processPath = normalizePath(process.node.path)

    // Get the org unit path from the process
    const orgUnitPath = normalizePath(process.orgUnit.node.path)

    // Extract steps from graph nodes
    const steps = yield* extractSteps(graph, processPath)

    // Extract flows from graph edges
    const flows = yield* extractFlows(graph)

    // Extract role responsibilities
    const responsibilities = extractResponsibilitiesFromProcess(process)

    // Extract phases from steps (order determined by first appearance)
    const phases = extractPhasesFromProcess(process, graph)

    // Extract SLA if present
    const sla = extractSlaData(process.props.sla)

    return {
      orgUnitPath,
      name: process.props.name,
      path: processPath,
      purpose: process.props.purpose,
      steps,
      flows,
      responsibilities,
      phases,
      ...(sla && { sla }),
    }
  })

/**
 * Extracts all steps from a process graph.
 * Filters out virtual __start__ and __end__ nodes.
 */
const extractSteps = (
  graph: DirectedGraph<GraphNode, GraphEdge>,
  processPath: string,
): Effect.Effect<ExtractedStepData[]> =>
  Effect.gen(function* () {
    const nodes = graph
      .nodes()
      .filter((nodeId: string) => !Process.isVirtualNode(nodeId))

    // Process all nodes in parallel
    return yield* Effect.forEach(
      nodes,
      (nodeId: string) => extractStepData(graph, nodeId, processPath),
      { concurrency: "unbounded" },
    )
  })

/**
 * Extracts data for a single step.
 * processPath is already normalized.
 */
const extractStepData = (
  graph: DirectedGraph<GraphNode, GraphEdge>,
  nodeId: string,
  processPath: string,
): Effect.Effect<ExtractedStepData> => {
  const step = graph.getNodeAttributes(nodeId)

  // Extract role path if step has a role (system steps have no role)
  const rolePath = step.props.role
    ? normalizePath(step.props.role.node.path)
    : undefined

  // Extract form field count if this is a Form step
  const formFields = isForm(step) ? step.totalFields : undefined

  // Extract supporting role paths if this is a Form step
  const supportingRolePaths =
    isForm(step) && step.supportingRoles
      ? step.supportingRoles.map((role) => normalizePath(role.node.path))
      : undefined

  // Extract phase path if step has a phase
  const phasePath = step.props.phase
    ? normalizePath(step.props.phase.node.path)
    : undefined

  // Extract SLA if present
  const sla = extractSlaData(step.props.sla)

  // Extract hasForEach from the step's brand property
  const hasForEach = step.hasForEach === true ? true : undefined

  const embedded =
    step.isForm &&
    (step as unknown as Form<Record<string, unknown>, Record<string, never>>)
      .embed
      ? true
      : undefined

  // Extract retryLimit from system steps.
  // Note: Using property-based check and cast instead of instanceof because
  // the org code may be compiled separately from this package (cross-bundle boundary).
  // The isSystemStep property is the reliable runtime identifier across bundles.
  const retryLimit = step.isSystemStep
    ? (step as { retries?: number }).retries
    : undefined

  // Extract document store references for Form steps
  const documentStoreReferences = extractDocumentStoreReferencesFromStep(step)

  return Effect.succeed({
    name: step.props.name ?? step.node.id,
    purpose: step.props.purpose ?? "",
    processPath,
    path: normalizePath(step.node.path),
    ...(rolePath !== undefined && { rolePath }),
    ...(supportingRolePaths !== undefined && { supportingRolePaths }),
    ...(formFields !== undefined && { formFields }),
    ...(phasePath !== undefined && { phasePath }),
    ...(sla && { sla }),
    ...(hasForEach !== undefined && { hasForEach }),
    ...(embedded !== undefined && { embedded }),
    ...(retryLimit !== undefined && { retryLimit }),
    ...(documentStoreReferences !== undefined && { documentStoreReferences }),
  })
}

/**
 * Extracts all flows from a process graph.
 * Filters out edges from __start__ and edges to __end__.
 */
const extractFlows = (
  graph: DirectedGraph<GraphNode, GraphEdge>,
): Effect.Effect<ExtractedFlowData[]> =>
  Effect.gen(function* () {
    const edges = graph.edges().filter((edge) => {
      const source = graph.source(edge)
      const target = graph.target(edge)
      return !Process.isVirtualNode(source) && !Process.isVirtualNode(target)
    })

    return yield* Effect.forEach(
      edges,
      (edge) => extractFlowData(graph, edge),
      { concurrency: "unbounded" },
    )
  })

/**
 * Extracts data for a single flow.
 * If the edge has a condition function, sets condition to either the provided
 * conditionText or "conditional" as a default.
 * If the edge has a schedule function, sets schedule to either the provided
 * scheduleText or "scheduled" as a default.
 */
const extractFlowData = (
  graph: DirectedGraph<GraphNode, GraphEdge>,
  edge: string,
): Effect.Effect<ExtractedFlowData> =>
  Effect.sync(() => {
    const source = graph.source(edge)
    const target = graph.target(edge)
    const sourceAttributes = graph.getNodeAttributes(source)
    const targetAttributes = graph.getNodeAttributes(target)
    const edgeAttributes = graph.getEdgeAttributes(edge)

    const sourceStepPath = normalizePath(sourceAttributes.node.path)
    const targetStepPath = normalizePath(targetAttributes.node.path)

    // Determine condition text: use provided text, or "conditional" if condition function exists
    const condition = edgeAttributes.conditionText
      ? edgeAttributes.conditionText
      : edgeAttributes.condition
        ? "conditional"
        : undefined

    // Determine schedule text: use provided text, or "scheduled" if schedule function exists
    const schedule = edgeAttributes.scheduleText
      ? edgeAttributes.scheduleText
      : edgeAttributes.schedule
        ? "scheduled"
        : undefined

    const data: ExtractedFlowData = {
      sourceStepPath,
      targetStepPath,
      ...(condition && { condition }),
      ...(schedule && { schedule }),
      isElse: edgeAttributes.isElse ?? false,
      isOnError: edgeAttributes.isOnError ?? false,
      taggedErrors: edgeAttributes.taggedErrors ?? null,
    }
    return data
  })

/**
 * Walk the organisation tree and extract invitation configurations.
 *
 * @param org - The organisation to walk
 * @returns Array of extracted invitation data
 */
export const walkInvitations = (
  org: Organisation,
): readonly ExtractedInvitationData[] => {
  const invitations: ExtractedInvitationData[] = []

  // Find Invitation constructs in organisation's children
  for (const child of org.node.children) {
    if (isInvitation(child)) {
      invitations.push({
        id: child.node.id,
        // Normalize email to lowercase for case-insensitive matching
        email: child.email.toLowerCase(),
        // Extract role paths from Role constructs (normalized)
        rolePaths: child.roles.map((role) => normalizePath(role.node.path)),
      })
    }
  }

  return invitations
}

/**
 * Extracted authentication configuration data from an organisation.
 */
export interface ExtractedAuthConfigData {
  readonly delegatedAccess: boolean
  readonly inviteOnly: boolean
  readonly identityProviders: ReadonlyArray<{
    readonly name: OAuthProviderName
    readonly config: OAuthProviderConfig
  }>
  readonly passkey?: PasskeyProviderConfig
}

/**
 * Extracted secret client data from an organisation.
 */
export interface ExtractedSecretClientData {
  readonly clientId: string
  readonly secret: string
  readonly audience: string
}

/**
 * Walk the organisation tree and extract authentication configuration.
 *
 * @param org - The organisation to walk
 * @returns Extracted authentication configuration data
 */
export const walkAuthenticationConfig = (
  org: Organisation,
): ExtractedAuthConfigData => {
  const identityProviders: Array<{
    name: OAuthProviderName
    config: OAuthProviderConfig
  }> = []
  let inviteOnly = true
  let delegatedAccess = false
  let passkey: PasskeyProviderConfig | undefined

  // Find AuthenticationConfig in organisation's children
  for (const child of org.node.children) {
    if (isAuthenticationConfig(child)) {
      inviteOnly = child.inviteOnly
      delegatedAccess = child.delegatedAccess
      for (const provider of child.identityProviders) {
        identityProviders.push({
          name: provider.name,
          config: provider.config,
        })
      }
      // Extract passkey config if present
      if (child.passkey) {
        passkey = child.passkey
      }
    }
  }

  return passkey
    ? { inviteOnly, delegatedAccess, identityProviders, passkey }
    : { inviteOnly, delegatedAccess, identityProviders }
}

/**
 * Walk the organisation tree and extract secret client configurations.
 *
 * @param org - The organisation to walk
 * @returns Array of extracted secret client data
 */
export const walkSecretClients = (
  org: Organisation,
): readonly ExtractedSecretClientData[] => {
  const secretClients: ExtractedSecretClientData[] = []

  // Find AuthenticationConfig in organisation's children
  for (const child of org.node.children) {
    if (isAuthenticationConfig(child)) {
      for (const client of child.secretClients) {
        secretClients.push({
          clientId: client.clientId,
          secret: client.secret,
          audience: client.audience,
        })
      }
    }
  }

  return secretClients
}

/**
 * Extracts document store references from a schema's AST annotations.
 * Looks for FormFileInput annotations which contain documentStore paths.
 */
const extractDocumentStoreReferencesFromSchema = (
  schema: Schema.Struct.Fields[string],
): string[] => {
  const documentStores: string[] = []
  const seen = new Set<string>() // Track seen paths to avoid duplicates

  const walk = (ast: AST.AST): void => {
    // Check for FormFileInput annotation on this AST node
    const metadata = ast.annotations[FormFileInput]
    if (
      typeof metadata === "object" &&
      metadata !== null &&
      "documentStore" in metadata &&
      typeof metadata.documentStore === "string" &&
      metadata.documentStore.length > 0 &&
      !seen.has(metadata.documentStore)
    ) {
      seen.add(metadata.documentStore)
      documentStores.push(metadata.documentStore)
    }

    // Preserve annotations on every wrapper while following the encoded schema.
    if (ast._tag === "Refinement" || ast._tag === "Transformation") {
      walk(ast.from)
      return
    }

    // Recursively walk into struct fields
    if (ast._tag === "TypeLiteral") {
      for (const prop of ast.propertySignatures) {
        walk(prop.type)
      }
    }

    // Handle union types
    if (ast._tag === "Union") {
      for (const member of ast.types) {
        walk(member)
      }
    }
  }

  walk(fieldInputAst(schema))
  return documentStores
}

/**
 * Extracts document store references from a Form step's output fields.
 * Returns undefined if the step is not a Form or has no file inputs.
 */
const extractDocumentStoreReferencesFromStep = (
  step: GraphNode,
): string[] | undefined => {
  // Only Form steps can have file inputs
  if (!isForm(step)) {
    return undefined
  }

  const output = step.output
  if (!output) {
    return undefined
  }

  // Walk all fields in the form output
  const allDocumentStores: string[] = []
  const seen = new Set<string>()

  for (const fieldSchema of Object.values(output)) {
    const stores = extractDocumentStoreReferencesFromSchema(fieldSchema)
    for (const store of stores) {
      if (!seen.has(store)) {
        seen.add(store)
        allDocumentStores.push(store)
      }
    }
  }

  return allDocumentStores.length > 0 ? allDocumentStores : undefined
}

/**
 * Walk the organisation tree and extract document store configurations.
 * DocumentStore constructs can appear as children of the root organisation
 * or any org unit in the hierarchy.
 *
 * @param org - The organisation to walk
 * @returns Array of extracted document store data
 */
export const walkDocumentStores = (
  org: Organisation,
): readonly ExtractedDocumentStoreData[] => {
  const stores: ExtractedDocumentStoreData[] = []

  const walkOrgUnit = (orgUnit: OrgUnit): void => {
    const orgUnitPath = normalizePath(orgUnit.node.path)

    for (const child of orgUnit.node.children) {
      if (isDocumentStore(child)) {
        stores.push({
          orgUnitPath,
          name: child.node.id,
          path: normalizePath(child.node.path),
          ...(child.acceptedTypes.length > 0 && {
            acceptedTypes: child.acceptedTypes as string[],
          }),
          ...(child.maxFileSize !== 100 * 1024 * 1024 && {
            maxFileSize: child.maxFileSize,
          }),
        })
      } else if (isOrgUnit(child)) {
        walkOrgUnit(child)
      }
    }
  }

  walkOrgUnit(org)

  return stores
}
