import type { ExecutorDescriptor } from "@processfocus/runtime"
import { Schema } from "effect"
import { DayOfMonth, type TimeOfDay } from "@pf/business-calendar"
import { normalizePath } from "./org-utils"
import { type Organisation, validateTimeZone } from "./organisation"
import type { CronWeekday, ProcessCron } from "./process"

/**
 * Namespaced extension keys for provider- or operation-specific metadata. The
 * portable core of the deploy manifest must stay provider-neutral; anything
 * that names an AWS topology detail, an internal executor, or a private policy
 * lives behind one of these reviewed keys.
 */
export const AWS_RUNTIME_EXTENSION = "processfocus/aws-runtime"
export const EXECUTOR_DESCRIPTORS_EXTENSION = "processfocus/executors"

export interface ArtifactProducer {
  readonly name: string
  readonly version: string
}

export interface DockerStepMetadata {
  readonly stepPath: string
  readonly dockerContext: string
  readonly dockerfile: string
  readonly command?: string
}

export interface DocumentStoreMetadata {
  readonly name: string
  readonly path: string
  readonly expirationDays: number | undefined
}

export interface AwsRolePolicyStatementMetadata {
  readonly actions: string[]
  readonly resources: string[]
  readonly effect?: "allow" | "deny"
}

export interface AwsRuntimeMetadata {
  readonly graphqlLambdaRolePolicyStatements?: AwsRolePolicyStatementMetadata[]
  readonly jobWorkerLambdaRolePolicyStatements?: AwsRolePolicyStatementMetadata[]
}

export interface CronEntryMetadata {
  readonly processPath: string
  readonly startMutationName: string
  readonly cron: ProcessCron
}

export interface OrganisationDeployManifest {
  readonly format?: string | undefined
  readonly version: typeof ORGANISATION_DEPLOY_MANIFEST_VERSION
  readonly producer?: ArtifactProducer | undefined
  readonly orgBundleSha256: string
  readonly organisationTimeZone: string
  readonly hasLongDurationSteps: boolean
  readonly dockerSteps: DockerStepMetadata[]
  readonly documentStores: DocumentStoreMetadata[]
  readonly cronEntries: CronEntryMetadata[]
  readonly customDomains?: Record<string, string> | undefined
  readonly extensions: Readonly<Record<string, unknown>>
}

export interface AwsRuntimeExtension {
  readonly awsFunctionNames: readonly string[]
  readonly awsRuntime?: AwsRuntimeMetadata | undefined
}

export type ExecutorDescriptorsExtension = Readonly<
  Record<string, ExecutorDescriptor>
>

/** Namespaced extension carrying AWS-side deployment metadata. */
export const awsRuntimeExtension = (
  manifest: OrganisationDeployManifest,
): AwsRuntimeExtension => {
  const value = manifest.extensions[AWS_RUNTIME_EXTENSION] as
    | Partial<AwsRuntimeExtension>
    | undefined

  return {
    awsFunctionNames: value?.awsFunctionNames ?? [],
    ...(value?.awsRuntime !== undefined
      ? { awsRuntime: value.awsRuntime }
      : {}),
  }
}

/** Namespaced extension mapping step paths to organisation-owned executors. */
export const executorDescriptorsExtension = (
  manifest: OrganisationDeployManifest,
): ExecutorDescriptorsExtension =>
  readExecutorDescriptorsExtension(
    manifest.extensions[EXECUTOR_DESCRIPTORS_EXTENSION],
  )

export const ORGANISATION_DEPLOY_MANIFEST_FILE = "deploy-manifest.json"
export const ORGANISATION_DEPLOY_MANIFEST_VERSION = 3 as const
export const ORGANISATION_DEPLOY_MANIFEST_FORMAT =
  "processfocus/deploy-manifest"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string")

const CRON_WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const satisfies readonly CronWeekday[]

const decodeDayOfMonth = Schema.decodeSync(DayOfMonth)

const ensureRecord = (
  value: unknown,
  path: string,
): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new Error(`${path} must be an object`)
  }

  return value
}

const ensureString = (value: unknown, path: string): string => {
  if (typeof value !== "string") {
    throw new Error(`${path} must be a string`)
  }

  return value
}

const ensureSha256Hex = (value: unknown, path: string): string => {
  const parsed = ensureString(value, path)

  if (!/^[0-9a-f]{64}$/.test(parsed)) {
    throw new Error(`${path} must be a 64-character hex string`)
  }

  return parsed
}

const ensureBoolean = (value: unknown, path: string): boolean => {
  if (typeof value !== "boolean") {
    throw new Error(`${path} must be a boolean`)
  }

  return value
}

const ensureNormalizedPath = (value: unknown, path: string): string => {
  const parsed = ensureString(value, path)

  if (!parsed.startsWith("/")) {
    throw new Error(`${path} must start with '/'`)
  }

  return parsed
}

const ensureExecutorDescriptor = (
  value: unknown,
  path: string,
): ExecutorDescriptor => {
  const record = ensureRecord(value, path)
  const id = ensureString(record["id"], `${path}.id`)
  if (id.length === 0) {
    throw new Error(`${path}.id must not be empty`)
  }

  return {
    id,
    extensions: ensureRecord(record["extensions"], `${path}.extensions`),
  }
}

const readExecutorDescriptorsExtension = (
  value: unknown,
): ExecutorDescriptorsExtension => {
  if (value === undefined) {
    return {}
  }

  const descriptors = ensureRecord(
    value,
    `extensions.${EXECUTOR_DESCRIPTORS_EXTENSION}`,
  )
  return Object.fromEntries(
    Object.entries(descriptors).map(([stepPath, descriptor]) => {
      const normalizedStepPath = ensureNormalizedPath(
        stepPath,
        `extensions.${EXECUTOR_DESCRIPTORS_EXTENSION} key`,
      )
      return [
        normalizedStepPath,
        ensureExecutorDescriptor(
          descriptor,
          `extensions.${EXECUTOR_DESCRIPTORS_EXTENSION}.${stepPath}`,
        ),
      ]
    }),
  )
}

const ensureTimeZone = (value: unknown, path: string): string => {
  const parsed = ensureString(value, path)
  validateTimeZone(parsed)
  return parsed
}

const ensureOptionalNumber = (
  value: unknown,
  path: string,
): number | undefined => {
  if (value === undefined || value === null) {
    return undefined
  }

  if (typeof value !== "number") {
    throw new Error(`${path} must be a number when provided`)
  }

  return value
}

const ensureInteger = (value: unknown, path: string): number => {
  if (!Number.isInteger(value)) {
    throw new Error(`${path} must be an integer`)
  }

  return value as number
}

const ensureMinute = (value: unknown, path: string): number => {
  const minute = ensureInteger(value, path)

  if (minute < 0 || minute > 59) {
    throw new Error(`${path} must be between 0 and 59`)
  }

  return minute
}

const ensureTimeOfDay = (value: unknown, path: string): TimeOfDay => {
  const record = ensureRecord(value, path)
  const hour = ensureInteger(record["hour"], `${path}.hour`)
  const minute = ensureMinute(record["minute"], `${path}.minute`)

  if (hour < 0 || hour > 23) {
    throw new Error(`${path}.hour must be between 0 and 23`)
  }

  return { hour, minute }
}

const ensureCronWeekday = (value: unknown, path: string): CronWeekday => {
  const weekday = ensureString(value, path)

  if (!CRON_WEEKDAYS.includes(weekday as CronWeekday)) {
    throw new Error(`${path} must be one of: ${CRON_WEEKDAYS.join(", ")}`)
  }

  return weekday as CronWeekday
}

const ensureDayOfMonth = (value: unknown, path: string): DayOfMonth => {
  const dayOfMonth = ensureInteger(value, path)

  try {
    return decodeDayOfMonth(dayOfMonth)
  } catch {
    throw new Error(`${path} must be between 1 and 31`)
  }
}

const readOptionalTimeZone = (
  value: unknown,
  path: string,
): string | undefined => {
  if (value === undefined || value === null) {
    return undefined
  }

  const timeZone = ensureString(value, path)
  validateTimeZone(timeZone)
  return timeZone
}

const readCronTimeZone = (record: Record<string, unknown>, path: string) => {
  const timeZone = readOptionalTimeZone(record["timeZone"], `${path}.timeZone`)
  return timeZone ? { timeZone } : {}
}

const readProcessCron = (value: unknown, path: string): ProcessCron => {
  const record = ensureRecord(value, path)
  const type = ensureString(record["type"], `${path}.type`)

  switch (type) {
    case "hourly":
      return {
        type,
        minute: ensureMinute(record["minute"], `${path}.minute`),
        ...readCronTimeZone(record, path),
      }
    case "daily":
      return {
        type,
        at: ensureTimeOfDay(record["at"], `${path}.at`),
        ...readCronTimeZone(record, path),
      }
    case "weekly":
      return {
        type,
        weekday: ensureCronWeekday(record["weekday"], `${path}.weekday`),
        at: ensureTimeOfDay(record["at"], `${path}.at`),
        ...readCronTimeZone(record, path),
      }
    case "monthly":
      return {
        type,
        dayOfMonth: ensureDayOfMonth(
          record["dayOfMonth"],
          `${path}.dayOfMonth`,
        ),
        at: ensureTimeOfDay(record["at"], `${path}.at`),
        ...readCronTimeZone(record, path),
      }
    default:
      throw new Error(
        `${path}.type must be one of: hourly, daily, weekly, monthly`,
      )
  }
}

const readCronEntries = (
  value: unknown,
  path = "cronEntries",
): CronEntryMetadata[] => {
  if (value === undefined || value === null) {
    return []
  }

  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array`)
  }

  return value.map((entry, index) => {
    const record = ensureRecord(entry, `${path}[${index}]`)

    return {
      processPath: ensureNormalizedPath(
        record["processPath"],
        `${path}[${index}].processPath`,
      ),
      startMutationName: ensureString(
        record["startMutationName"],
        `${path}[${index}].startMutationName`,
      ),
      cron: readProcessCron(record["cron"], `${path}[${index}].cron`),
    }
  })
}

const buildCronEntries = (org: Organisation): CronEntryMetadata[] =>
  org
    .processes()
    .flatMap((process) => {
      const cron = process.props.cron
      if (!cron) {
        return []
      }

      const processPath = normalizePath(process.node.path)
      const startNodes = process.startNodes()

      if (startNodes.length !== 1) {
        throw new Error(
          `Process ${processPath} declares cron but has ${startNodes.length} start steps. Cron requires exactly one start step.`,
        )
      }

      const startNode = startNodes[0]
      if (!startNode?.isSystemStep) {
        const startStepPath = startNode
          ? normalizePath(startNode.node.path)
          : "<unknown>"
        throw new Error(
          `Process ${processPath} declares cron but start step ${startStepPath} is not a system step. Cron requires a single system start step.`,
        )
      }

      return [
        {
          processPath,
          startMutationName: process.startMutationName(),
          cron,
        },
      ]
    })
    .sort((left, right) => left.processPath.localeCompare(right.processPath))

const ensureStringArray = (value: unknown, path: string): string[] => {
  if (!isStringArray(value)) {
    throw new Error(`${path} must be an array of strings`)
  }

  if (value.some((item) => item.length === 0)) {
    throw new Error(`${path} must not contain empty strings`)
  }

  return value
}

const readAwsRolePolicyStatements = (
  value: unknown,
  path: string,
): AwsRolePolicyStatementMetadata[] | undefined => {
  if (value === undefined) {
    return undefined
  }

  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array`)
  }

  return value.map((statement, index) => {
    const statementPath = `${path}[${index}]`
    const record = ensureRecord(statement, statementPath)
    const actions = ensureStringArray(
      record["actions"],
      `${statementPath}.actions`,
    )
    const resources = ensureStringArray(
      record["resources"],
      `${statementPath}.resources`,
    )
    const effect = record["effect"]

    if (actions.length === 0) {
      throw new Error(`${statementPath}.actions must not be empty`)
    }

    if (resources.length === 0) {
      throw new Error(`${statementPath}.resources must not be empty`)
    }

    if (effect !== undefined && effect !== "allow" && effect !== "deny") {
      throw new Error(`${statementPath}.effect must be 'allow' or 'deny'`)
    }

    return {
      actions,
      resources,
      ...(effect !== undefined ? { effect } : {}),
    }
  })
}

const readAwsRuntimeMetadata = (
  value: unknown,
  path = "awsRuntime",
): AwsRuntimeMetadata | undefined => {
  if (value === undefined || value === null) {
    return undefined
  }

  // Build-time validation points at the source export name (`CustomAwsRuntimeConfig`)
  // while manifest parsing points at the artifact field name (`awsRuntime`).
  const record = ensureRecord(value, path)
  const parsedGraphqlLambdaRolePolicyStatements = readAwsRolePolicyStatements(
    record["graphqlLambdaRolePolicyStatements"],
    `${path}.graphqlLambdaRolePolicyStatements`,
  )
  const parsedJobWorkerLambdaRolePolicyStatements = readAwsRolePolicyStatements(
    record["jobWorkerLambdaRolePolicyStatements"],
    `${path}.jobWorkerLambdaRolePolicyStatements`,
  )

  const parsedAwsRuntime = {
    ...(parsedGraphqlLambdaRolePolicyStatements
      ? {
          graphqlLambdaRolePolicyStatements:
            parsedGraphqlLambdaRolePolicyStatements,
        }
      : {}),
    ...(parsedJobWorkerLambdaRolePolicyStatements
      ? {
          jobWorkerLambdaRolePolicyStatements:
            parsedJobWorkerLambdaRolePolicyStatements,
        }
      : {}),
  }

  return Object.keys(parsedAwsRuntime).length > 0 ? parsedAwsRuntime : undefined
}

const readCustomDomains = (
  value: unknown,
  path = "customDomains",
): Record<string, string> | undefined => {
  if (value === undefined) {
    return undefined
  }

  const record = ensureRecord(value, path)
  const entries = Object.entries(record).map(([key, entryValue]) => [
    key,
    ensureString(entryValue, `${path}.${key}`),
  ])

  if (entries.length === 0) {
    return undefined
  }

  return Object.fromEntries(entries)
}

const readArtifactProducer = (value: unknown): ArtifactProducer | undefined => {
  if (value === undefined || value === null) {
    return undefined
  }

  const record = ensureRecord(value, "producer")

  return {
    name: ensureString(record["name"], "producer.name"),
    version: ensureString(record["version"], "producer.version"),
  }
}

const readExtensions = (value: unknown): Record<string, unknown> => {
  if (value === undefined || value === null) {
    return {}
  }

  return ensureRecord(value, "extensions")
}

export const parseOrganisationDeployManifest = (
  value: unknown,
): OrganisationDeployManifest => {
  const record = ensureRecord(value, "organisation deploy manifest")
  const version = record["version"]

  if (version !== ORGANISATION_DEPLOY_MANIFEST_VERSION) {
    throw new Error(
      `organisation deploy manifest version must be ${String(ORGANISATION_DEPLOY_MANIFEST_VERSION)}`,
    )
  }

  const declaredFormat = record["format"]
  if (
    declaredFormat !== undefined &&
    declaredFormat !== ORGANISATION_DEPLOY_MANIFEST_FORMAT
  ) {
    throw new Error(
      `organisation deploy manifest format must be ${ORGANISATION_DEPLOY_MANIFEST_FORMAT}`,
    )
  }

  const producer = readArtifactProducer(record["producer"])

  const dockerStepsValue = record["dockerSteps"]
  if (!Array.isArray(dockerStepsValue)) {
    throw new Error("dockerSteps must be an array")
  }

  const documentStoresValue = record["documentStores"]
  if (!Array.isArray(documentStoresValue)) {
    throw new Error("documentStores must be an array")
  }

  const extensions = readExtensions(record["extensions"])

  // Legacy manifests carried AWS data at the portable top level. Normalize it
  // into its namespaced extension so consumers only ever read one location.
  const awsExtensionValue = extensions[AWS_RUNTIME_EXTENSION]
  const awsExtension = isRecord(awsExtensionValue) ? awsExtensionValue : {}
  const legacyAwsFunctionNames = Array.isArray(record["awsFunctionNames"])
    ? ensureStringArray(record["awsFunctionNames"], "awsFunctionNames")
    : []
  const awsFunctionNames = Array.isArray(awsExtension["awsFunctionNames"])
    ? ensureStringArray(
        awsExtension["awsFunctionNames"],
        "extensions.processfocus/aws-runtime.awsFunctionNames",
      )
    : legacyAwsFunctionNames

  const parsedLegacyAwsRuntime = readAwsRuntimeMetadata(record["awsRuntime"])
  const parsedExtensionAwsRuntime = readAwsRuntimeMetadata(
    awsExtension["awsRuntime"],
  )
  const awsRuntime = parsedExtensionAwsRuntime ?? parsedLegacyAwsRuntime

  const dockerSteps = dockerStepsValue.map((step, index) => {
    const record = ensureRecord(step, `dockerSteps[${index}]`)
    const command = record["command"]

    return {
      stepPath: ensureNormalizedPath(
        record["stepPath"],
        `dockerSteps[${index}].stepPath`,
      ),
      dockerContext: ensureString(
        record["dockerContext"],
        `dockerSteps[${index}].dockerContext`,
      ),
      dockerfile: ensureString(
        record["dockerfile"],
        `dockerSteps[${index}].dockerfile`,
      ),
      ...(command === undefined || command === null
        ? {}
        : {
            command: ensureString(command, `dockerSteps[${index}].command`),
          }),
    }
  })

  const normalizedExecutorDescriptors = readExecutorDescriptorsExtension(
    extensions[EXECUTOR_DESCRIPTORS_EXTENSION],
  )

  const normalizedExtensions: Record<string, unknown> = { ...extensions }
  if (awsFunctionNames.length > 0 || awsRuntime !== undefined) {
    normalizedExtensions[AWS_RUNTIME_EXTENSION] = {
      awsFunctionNames,
      ...(awsRuntime !== undefined ? { awsRuntime } : {}),
    }
  }
  if (Object.keys(normalizedExecutorDescriptors).length > 0) {
    normalizedExtensions[EXECUTOR_DESCRIPTORS_EXTENSION] =
      normalizedExecutorDescriptors
  }

  return {
    format: ORGANISATION_DEPLOY_MANIFEST_FORMAT,
    version,
    ...(producer !== undefined ? { producer } : {}),
    orgBundleSha256: ensureSha256Hex(
      record["orgBundleSha256"],
      "orgBundleSha256",
    ),
    organisationTimeZone: ensureTimeZone(
      record["organisationTimeZone"],
      "organisationTimeZone",
    ),
    hasLongDurationSteps: ensureBoolean(
      record["hasLongDurationSteps"],
      "hasLongDurationSteps",
    ),
    dockerSteps,
    documentStores: documentStoresValue.map((store, index) => {
      const record = ensureRecord(store, `documentStores[${index}]`)

      return {
        name: ensureString(record["name"], `documentStores[${index}].name`),
        path: ensureNormalizedPath(
          record["path"],
          `documentStores[${index}].path`,
        ),
        expirationDays: ensureOptionalNumber(
          record["expirationDays"],
          `documentStores[${index}].expirationDays`,
        ),
      }
    }),
    cronEntries: readCronEntries(record["cronEntries"]),
    customDomains: readCustomDomains(record["customDomains"]),
    extensions: normalizedExtensions,
  }
}

export const buildOrganisationDeployManifest = (options: {
  readonly org: Organisation
  readonly orgBundleSha256: string
  readonly producer?: ArtifactProducer | undefined
  readonly customAwsRuntimeConfig?: unknown
}): OrganisationDeployManifest => {
  const allConstructs = options.org.node.findAll()

  const customDomainNode = allConstructs.find((construct: unknown) => {
    const casted = construct as unknown as Record<string, unknown>
    return casted["isCustomDomain"] === true
  })

  const customDomains = customDomainNode
    ? {
        ...(customDomainNode as unknown as { domains: Record<string, string> })
          .domains,
      }
    : undefined

  const awsFunctionNames = allConstructs.reduce<string[]>(
    (names, construct) => {
      const casted = construct as unknown as Record<string, unknown>
      const functionName = casted["functionName"]
      if (typeof functionName === "string") {
        names.push(functionName)
      }
      return names
    },
    [],
  )

  const executorDescriptors: Record<string, ExecutorDescriptor> = {}
  const dockerSteps = allConstructs.reduce<DockerStepMetadata[]>(
    (steps, construct) => {
      const casted = construct as {
        isDockerStep?: unknown
        dockerContext?: unknown
        dockerfile?: unknown
        command?: unknown
        executor?: unknown
        node?: { path?: unknown }
      }

      if (
        casted.isDockerStep === true &&
        typeof casted.dockerContext === "string" &&
        typeof casted.dockerfile === "string" &&
        typeof casted.node?.path === "string"
      ) {
        const stepPath = normalizePath(casted.node.path)
        if (casted.executor !== undefined) {
          executorDescriptors[stepPath] = ensureExecutorDescriptor(
            casted.executor,
            `Docker step ${stepPath} executor`,
          )
        }

        steps.push({
          stepPath,
          dockerContext: casted.dockerContext,
          dockerfile: casted.dockerfile,
          ...(typeof casted.command === "string"
            ? { command: casted.command }
            : {}),
        })
      }

      return steps
    },
    [],
  )

  const awsRuntime = readAwsRuntimeMetadata(
    options.customAwsRuntimeConfig,
    "CustomAwsRuntimeConfig",
  )

  const extensions: Record<string, unknown> = {}
  if (awsFunctionNames.length > 0 || awsRuntime !== undefined) {
    extensions[AWS_RUNTIME_EXTENSION] = {
      awsFunctionNames,
      ...(awsRuntime !== undefined ? { awsRuntime } : {}),
    }
  }
  if (Object.keys(executorDescriptors).length > 0) {
    extensions[EXECUTOR_DESCRIPTORS_EXTENSION] = executorDescriptors
  }

  return {
    format: ORGANISATION_DEPLOY_MANIFEST_FORMAT,
    version: ORGANISATION_DEPLOY_MANIFEST_VERSION,
    ...(options.producer !== undefined ? { producer: options.producer } : {}),
    orgBundleSha256: options.orgBundleSha256,
    organisationTimeZone: options.org.timeZone,
    hasLongDurationSteps: allConstructs.some((construct) => {
      const casted = construct as unknown as Record<string, unknown>
      return casted["longDuration"] === true
    }),
    dockerSteps,
    documentStores: allConstructs.reduce<DocumentStoreMetadata[]>(
      (stores, construct) => {
        const casted = construct as {
          isDocumentStore?: unknown
          expirationDays?: unknown
          node?: { id?: unknown; path?: unknown }
        }

        if (
          casted.isDocumentStore === true &&
          typeof casted.node?.id === "string" &&
          typeof casted.node?.path === "string"
        ) {
          stores.push({
            name: casted.node.id,
            path: normalizePath(casted.node.path),
            expirationDays:
              typeof casted.expirationDays === "number"
                ? casted.expirationDays
                : undefined,
          })
        }

        return stores
      },
      [],
    ),
    cronEntries: buildCronEntries(options.org),
    customDomains,
    extensions,
  }
}
