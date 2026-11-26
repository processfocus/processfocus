import { Schema } from "effect"

export const HOSTED_CUSTOMER_DOCKER_STEPS_ERROR =
  "Docker steps are not supported in hosted customer projects. Remove DockerStep from the organisation; Docker steps are reserved for the Process Focus Cloud Backend."

const Name = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/)),
)

/** Only metadata and fixed remediation selectors cross the public boundary. */
export const ConfigurationPreflightDiagnostic = Schema.Struct({
  category: Schema.Literal("invalid-configuration"),
  owner: Schema.NonEmptyString,
  target: Schema.NonEmptyString,
  key: Schema.String.pipe(
    Schema.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/)),
  ),
  secret: Schema.Boolean,
  source: Schema.Literals(["stage", "platform"]),
})

export const ConfigurationPreflightExecutionFailure = Schema.Struct({
  category: Schema.Literal("execution-failure"),
  reason: Schema.Literals([
    "input",
    "loading",
    "contract",
    "validation",
    "timeout",
    "subprocess",
    "unsupported-docker-steps",
  ]),
})

export const ConfigurationPreflightFailure = Schema.Struct({
  format: Schema.Literal("processfocus/configuration-preflight-failure"),
  version: Schema.Literal(1),
  project: Schema.String.pipe(
    Schema.check(Schema.isPattern(/^\d{4}-\d{4}-\d{4}$/)),
  ),
  environment: Name,
  stage: Schema.String.pipe(
    Schema.check(Schema.isPattern(/^[^\p{C}\p{Zl}\p{Zp}]{1,256}$/u)),
  ),
  result: Schema.Union([
    Schema.Struct({
      category: Schema.Literal("invalid-configuration"),
      diagnostics: Schema.NonEmptyArray(ConfigurationPreflightDiagnostic),
    }),
    ConfigurationPreflightExecutionFailure,
  ]),
})
export type ConfigurationPreflightFailure =
  typeof ConfigurationPreflightFailure.Type

/** Discard parse errors: decoder inputs can include secrets. */
export const decodeConfigurationPreflightFailure = (
  value: unknown,
): ConfigurationPreflightFailure | undefined => {
  try {
    return Schema.decodeUnknownSync(ConfigurationPreflightFailure)(value)
  } catch {
    return undefined
  }
}

const shellArgument = (value: string): string =>
  /^[A-Za-z0-9_.-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", "'\\''")}'`

const diagnosticLabel = (value: string): string =>
  /[^A-Za-z0-9_.-]/.test(value) ? JSON.stringify(value) : value

export const formatConfigurationPreflightFailure = (
  failure: ConfigurationPreflightFailure,
): string => {
  const context = `project=${failure.project} environment=${failure.environment} stage=${failure.stage}`
  if (failure.result.category === "execution-failure") {
    if (failure.result.reason === "unsupported-docker-steps") {
      return `[configuration-preflight] ${context}: ${HOSTED_CUSTOMER_DOCKER_STEPS_ERROR}`
    }
    return `[configuration-preflight] ${context} execution-failure reason=${failure.result.reason} owner=organisation target=configuration key=Configuration: Could not load or execute the configuration contract. Rebuild the organisation and retry. If it persists, contact support.`
  }
  return failure.result.diagnostics
    .map((diagnostic) => {
      const remediation =
        diagnostic.source === "stage"
          ? `Set a valid ${diagnostic.secret ? "secret" : "value"} in the owning stage configuration: pfcli config set --project ${failure.project} --stage ${shellArgument(failure.stage)} ${diagnostic.secret ? "--secret " : ""}${diagnostic.key} (reads the exported variable).`
          : "The platform runtime configuration is invalid. Retry deployment; if it persists, contact support."
      return `[configuration-preflight] ${context} ${diagnostic.category} owner=${diagnosticLabel(diagnostic.owner)} target=${diagnosticLabel(diagnostic.target)} key=${diagnostic.key}: ${remediation}`
    })
    .join("\n")
}
