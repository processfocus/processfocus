export const OTLP_ENDPOINT_SSM_PARAMETER_ENV = "OTLP_ENDPOINT_SSM_PARAMETER"
export const GRAFANA_TOKEN_SSM_PARAMETER_ENV = "GRAFANA_TOKEN_SSM_PARAMETER"

/** OTLP/HTTP protocol configuration, independent of the receiver provider. */
export interface OtlpExportConfig {
  readonly tracesUrl: string
  readonly metricsUrl: string
  readonly headers: Readonly<Record<string, string>>
}

export function otlpSignalUrls(
  endpoint: string,
): Pick<OtlpExportConfig, "tracesUrl" | "metricsUrl"> {
  const url = new URL(endpoint)
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Expected an HTTP(S) OTLP base URL without credentials, query or fragment",
    )
  }
  const base = url.href.replace(/\/+$/, "")
  return { tracesUrl: `${base}/v1/traces`, metricsUrl: `${base}/v1/metrics` }
}

/** Called once by telemetry startup; the owning runtime retains the result. */
export async function resolveOtlpSsmConfig(options: {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly getParameter: (name: string) => Promise<string | undefined>
  readonly warn: (message: string) => void
}): Promise<OtlpExportConfig | undefined> {
  const endpointParameter = options.env[OTLP_ENDPOINT_SSM_PARAMETER_ENV]
  const credentialParameter = options.env[GRAFANA_TOKEN_SSM_PARAMETER_ENV]
  if (!endpointParameter || !credentialParameter) {
    options.warn(
      "[OTEL] Export disabled: missing endpoint or credential SSM parameter path",
    )
    return undefined
  }
  try {
    const [endpoint, credential] = await Promise.all([
      options.getParameter(endpointParameter),
      options.getParameter(credentialParameter),
    ])
    if (!endpoint?.trim() || !credential?.trim()) {
      options.warn(
        "[OTEL] Export disabled: empty endpoint or credential SSM parameter",
      )
      return undefined
    }
    return {
      ...otlpSignalUrls(endpoint),
      headers: { Authorization: `Basic ${credential}` },
    }
  } catch {
    // SDK errors can include secret values; report configuration context only.
    options.warn(
      "[OTEL] Export disabled: unable to read or validate endpoint/credential SSM configuration",
    )
    return undefined
  }
}
