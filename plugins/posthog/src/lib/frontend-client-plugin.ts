export interface PostHogFrontendClientPluginConfig {
  readonly apiKey: string
  readonly host: string
  readonly enabled?: boolean
}

export const POSTHOG_FRONTEND_CLIENT_PLUGIN_TYPE = "analytics.posthog" as const
export const POSTHOG_FRONTEND_CLIENT_PLUGIN_MODULE =
  "@processfocus/plugin-posthog/register-client" as const

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const ensureRecord = (
  value: unknown,
  path: string,
): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new Error(`${path} must be an object`)
  }

  return value
}

const ensureNonEmptyString = (value: unknown, path: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`)
  }

  return value.trim()
}

const ensureHttpUrl = (value: unknown, path: string): string => {
  const normalized = ensureNonEmptyString(value, path).replace(/\/+$/, "")

  let parsed: URL

  try {
    parsed = new URL(normalized)
  } catch {
    throw new Error(`${path} must be a valid http(s) URL`)
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${path} must be a valid http(s) URL`)
  }

  return normalized
}

const ensureOptionalBoolean = (
  value: unknown,
  path: string,
): boolean | undefined => {
  if (value === undefined) {
    return undefined
  }

  if (typeof value !== "boolean") {
    throw new Error(`${path} must be a boolean`)
  }

  return value
}

export const parsePostHogFrontendClientPluginConfig = (
  value: unknown,
  path = "posthog frontend client plugin config",
): PostHogFrontendClientPluginConfig => {
  const record = ensureRecord(value, path)
  const enabled = ensureOptionalBoolean(record["enabled"], `${path}.enabled`)

  return {
    apiKey: ensureNonEmptyString(record["apiKey"], `${path}.apiKey`),
    host: ensureHttpUrl(record["host"], `${path}.host`),
    ...(typeof enabled === "boolean" ? { enabled } : {}),
  }
}
