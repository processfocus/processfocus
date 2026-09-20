import type { ArtifactProducer } from "./artifact.js"

/**
 * Portable organisation deployment metadata consumed by hosted runtimes.
 *
 * The authoring SDK owns construction of this document. Runtime consumers own
 * parsing it, so a private runtime never needs the unpublished authoring
 * implementation packages merely to validate or bundle an artifact.
 */
export const ORGANISATION_DEPLOY_MANIFEST_FILE = "deploy-manifest.json"
export const ORGANISATION_DEPLOY_MANIFEST_VERSION = 3 as const
export const ORGANISATION_DEPLOY_MANIFEST_FORMAT =
  "processfocus/deploy-manifest"

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

export type CronWeekday =
  | "sunday"
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"

export interface TimeOfDay {
  readonly hour: number
  readonly minute: number
}

type CronTimeZone = { readonly timeZone?: string | undefined }

export type ProcessCron =
  | ({ readonly type: "hourly"; readonly minute: number } & CronTimeZone)
  | ({ readonly type: "daily"; readonly at: TimeOfDay } & CronTimeZone)
  | ({
      readonly type: "weekly"
      readonly weekday: CronWeekday
      readonly at: TimeOfDay
    } & CronTimeZone)
  | ({
      readonly type: "monthly"
      readonly dayOfMonth: number
      readonly at: TimeOfDay
    } & CronTimeZone)

export interface CronEntryMetadata {
  readonly processPath: string
  readonly startMutationName: string
  readonly cron: ProcessCron
}

export interface OrganisationDeployManifest {
  readonly format: typeof ORGANISATION_DEPLOY_MANIFEST_FORMAT
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const ensureRecord = (
  value: unknown,
  path: string,
): Record<string, unknown> => {
  if (!isRecord(value)) throw new Error(`${path} must be an object`)
  return value
}

const ensureString = (value: unknown, path: string): string => {
  if (typeof value !== "string") throw new Error(`${path} must be a string`)
  return value
}

const ensureBoolean = (value: unknown, path: string): boolean => {
  if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`)
  return value
}

const ensureInteger = (value: unknown, path: string): number => {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${path} must be an integer`)
  }
  return value
}

const ensureSha256 = (value: unknown, path: string): string => {
  const parsed = ensureString(value, path)
  if (!/^[0-9a-f]{64}$/.test(parsed)) {
    throw new Error(`${path} must be a 64-character hex string`)
  }
  return parsed
}

const ensureNormalPath = (value: unknown, path: string): string => {
  const parsed = ensureString(value, path)
  if (!parsed.startsWith("/")) throw new Error(`${path} must start with '/'`)
  return parsed
}

const ensureTimeZone = (value: unknown, path: string): string => {
  const timeZone = ensureString(value, path)
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format(0)
  } catch {
    throw new Error(`${path} must be a valid IANA timezone identifier`)
  }
  return timeZone
}

const readOptionalTimeZone = (
  value: unknown,
  path: string,
): string | undefined =>
  value === undefined || value === null
    ? undefined
    : ensureTimeZone(value, path)

const readCronTimeZone = (record: Record<string, unknown>, path: string) => {
  const timeZone = readOptionalTimeZone(record["timeZone"], `${path}.timeZone`)
  return timeZone === undefined ? {} : { timeZone }
}

const ensureMinute = (value: unknown, path: string): number => {
  const minute = ensureInteger(value, path)
  if (minute < 0 || minute > 59) {
    throw new Error(`${path} must be between 0 and 59`)
  }
  return minute
}

const readTimeOfDay = (value: unknown, path: string): TimeOfDay => {
  const record = ensureRecord(value, path)
  const hour = ensureInteger(record["hour"], `${path}.hour`)
  if (hour < 0 || hour > 23) {
    throw new Error(`${path}.hour must be between 0 and 23`)
  }
  return {
    hour,
    minute: ensureMinute(record["minute"], `${path}.minute`),
  }
}

const CRON_WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
] as const satisfies readonly CronWeekday[]

const readCronWeekday = (value: unknown, path: string): CronWeekday => {
  const weekday = ensureString(value, path)
  switch (weekday) {
    case "sunday":
    case "monday":
    case "tuesday":
    case "wednesday":
    case "thursday":
    case "friday":
    case "saturday":
      return weekday
    default:
      throw new Error(`${path} must be one of: ${CRON_WEEKDAYS.join(", ")}`)
  }
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
        at: readTimeOfDay(record["at"], `${path}.at`),
        ...readCronTimeZone(record, path),
      }
    case "weekly":
      return {
        type,
        weekday: readCronWeekday(record["weekday"], `${path}.weekday`),
        at: readTimeOfDay(record["at"], `${path}.at`),
        ...readCronTimeZone(record, path),
      }
    case "monthly": {
      const dayOfMonth = ensureInteger(
        record["dayOfMonth"],
        `${path}.dayOfMonth`,
      )
      if (dayOfMonth < 1 || dayOfMonth > 31) {
        throw new Error(`${path}.dayOfMonth must be between 1 and 31`)
      }
      return {
        type,
        dayOfMonth,
        at: readTimeOfDay(record["at"], `${path}.at`),
        ...readCronTimeZone(record, path),
      }
    }
    default:
      throw new Error(
        `${path}.type must be one of: hourly, daily, weekly, monthly`,
      )
  }
}

const readCronEntries = (value: unknown): CronEntryMetadata[] => {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error("cronEntries must be an array")
  return value.map((entry, index) => {
    const path = `cronEntries[${index}]`
    const record = ensureRecord(entry, path)
    return {
      processPath: ensureNormalPath(
        record["processPath"],
        `${path}.processPath`,
      ),
      startMutationName: ensureString(
        record["startMutationName"],
        `${path}.startMutationName`,
      ),
      cron: readProcessCron(record["cron"], `${path}.cron`),
    }
  })
}

const readCustomDomains = (
  value: unknown,
): Record<string, string> | undefined => {
  if (value === undefined) return undefined
  const entries = Object.entries(ensureRecord(value, "customDomains")).map(
    ([name, domain]) => [name, ensureString(domain, `customDomains.${name}`)],
  )
  return entries.length === 0 ? undefined : Object.fromEntries(entries)
}

const readOptionalNumber = (
  value: unknown,
  path: string,
): number | undefined => {
  if (value === undefined || value === null) return undefined
  if (typeof value !== "number") {
    throw new Error(`${path} must be a number when provided`)
  }
  return value
}

export const parseOrganisationDeployManifest = (
  value: unknown,
): OrganisationDeployManifest => {
  const record = ensureRecord(value, "organisation deploy manifest")
  const version = record["version"]
  if (version !== ORGANISATION_DEPLOY_MANIFEST_VERSION) {
    throw new Error(
      `organisation deploy manifest version must be ${ORGANISATION_DEPLOY_MANIFEST_VERSION}`,
    )
  }
  if (record["format"] !== ORGANISATION_DEPLOY_MANIFEST_FORMAT) {
    throw new Error(
      `organisation deploy manifest format must be ${ORGANISATION_DEPLOY_MANIFEST_FORMAT}`,
    )
  }

  const producerValue = record["producer"]
  const producer =
    producerValue === undefined || producerValue === null
      ? undefined
      : (() => {
          const parsed = ensureRecord(producerValue, "producer")
          return {
            name: ensureString(parsed["name"], "producer.name"),
            version: ensureString(parsed["version"], "producer.version"),
          }
        })()
  const dockerStepsValue = record["dockerSteps"]
  const documentStoresValue = record["documentStores"]
  if (!Array.isArray(dockerStepsValue)) {
    throw new Error("dockerSteps must be an array")
  }
  if (!Array.isArray(documentStoresValue)) {
    throw new Error("documentStores must be an array")
  }

  const extensions =
    record["extensions"] === undefined || record["extensions"] === null
      ? {}
      : ensureRecord(record["extensions"], "extensions")
  const dockerSteps = dockerStepsValue.map((value, index) => {
    const path = `dockerSteps[${index}]`
    const step = ensureRecord(value, path)
    const command = step["command"]
    return {
      stepPath: ensureNormalPath(step["stepPath"], `${path}.stepPath`),
      dockerContext: ensureString(
        step["dockerContext"],
        `${path}.dockerContext`,
      ),
      dockerfile: ensureString(step["dockerfile"], `${path}.dockerfile`),
      ...(command === undefined || command === null
        ? {}
        : { command: ensureString(command, `${path}.command`) }),
    } satisfies DockerStepMetadata
  })

  return {
    format: ORGANISATION_DEPLOY_MANIFEST_FORMAT,
    version,
    ...(producer === undefined ? {} : { producer }),
    orgBundleSha256: ensureSha256(record["orgBundleSha256"], "orgBundleSha256"),
    organisationTimeZone: ensureTimeZone(
      record["organisationTimeZone"],
      "organisationTimeZone",
    ),
    hasLongDurationSteps: ensureBoolean(
      record["hasLongDurationSteps"],
      "hasLongDurationSteps",
    ),
    dockerSteps,
    documentStores: documentStoresValue.map((value, index) => {
      const path = `documentStores[${index}]`
      const store = ensureRecord(value, path)
      const expirationDays = store["expirationDays"]
      return {
        name: ensureString(store["name"], `${path}.name`),
        path: ensureNormalPath(store["path"], `${path}.path`),
        expirationDays: readOptionalNumber(
          expirationDays,
          `${path}.expirationDays`,
        ),
      }
    }),
    cronEntries: readCronEntries(record["cronEntries"]),
    customDomains: readCustomDomains(record["customDomains"]),
    extensions,
  }
}
