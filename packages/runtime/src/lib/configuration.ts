import { Config, Data, Effect, Option, Redacted, Result, Schema } from "effect"

export interface ConfigurationField<A = unknown> {
  readonly key: string
  readonly secret: boolean
  readonly source: "stage" | "platform"
  readonly config: Config.Config<A>
}

export interface ConfigurationGroup {
  readonly owner: string
  readonly target: string
  readonly fields: Readonly<Record<string, ConfigurationField>>
  readonly rules: readonly {
    readonly when: string
    readonly equals: boolean
    readonly required: string
  }[]
}

export interface ConfigurationContract {
  readonly version: 1
  readonly groups: readonly ConfigurationGroup[]
}

export interface ConfigurationDiagnostic {
  readonly owner: string
  readonly target: string
  readonly key: string
  readonly category: "invalid-configuration"
  readonly remediation: string
  readonly secret: boolean
  readonly source: "stage" | "platform"
}

export class ConfigurationError extends Data.TaggedError("ConfigurationError")<{
  readonly diagnostics: readonly ConfigurationDiagnostic[]
}> {}

export const configurationField = <A>(
  key: string,
  config: Config.Config<A>,
  options: {
    readonly secret?: boolean
    readonly source?: "stage" | "platform"
  } = {},
): ConfigurationField<A> => ({
  key,
  config,
  secret: options.secret ?? false,
  source: options.source ?? "stage",
})

/** Required strings reject whitespace, without retaining decoder input in errors. */
export const configurationString = (key: string): Config.Config<string> =>
  Config.schema(
    Schema.String.pipe(Schema.check(Schema.isPattern(/\S/))),
    key,
  ).pipe(Config.map((value) => value.trim()))

export const configurationSecret = (key: string) =>
  configurationString(key).pipe(Config.map((value) => Redacted.make(value)))

const diagnostic = (
  group: ConfigurationGroup,
  field: ConfigurationField,
): ConfigurationDiagnostic => ({
  owner: group.owner,
  target: group.target,
  key: field.key,
  category: "invalid-configuration",
  secret: field.secret,
  source: field.source,
  remediation: `Set a valid ${field.secret ? "secret" : "value"} for ${field.key} in ${field.source === "stage" ? "the owning stage configuration" : "the platform runtime configuration"}.`,
})

type Values<G extends ConfigurationGroup> = {
  readonly [K in keyof G["fields"]]: G["fields"][K] extends ConfigurationField<
    infer A
  >
    ? A
    : never
}

/** Runtime and preflight use this same decoding and conditional-rule evaluator. */
export const readConfiguration = <G extends ConfigurationGroup>(
  group: G,
): Effect.Effect<Values<G>, ConfigurationError> =>
  Effect.gen(function* () {
    const diagnostics: ConfigurationDiagnostic[] = []
    const values: Record<string, unknown> = {}
    const decoded = new Set<string>()
    for (const [name, field] of Object.entries(group.fields)) {
      const result = yield* Effect.result(field.config)
      if (Result.isFailure(result)) {
        diagnostics.push(diagnostic(group, field))
      } else {
        values[name] = result.success
        decoded.add(name)
      }
    }
    for (const rule of group.rules) {
      if (!decoded.has(rule.when) || !decoded.has(rule.required)) continue
      const required = values[rule.required]
      if (
        values[rule.when] === rule.equals &&
        (required === undefined ||
          (Option.isOption(required) && Option.isNone(required)))
      ) {
        const field = group.fields[rule.required]
        if (field) diagnostics.push(diagnostic(group, field))
      }
    }
    if (diagnostics.length > 0)
      return yield* new ConfigurationError({ diagnostics })
    // Every entry has been decoded by its field's typed Config above.
    return values as Values<G>
  })

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Executable definitions survive org.js bundling; reject absent or malformed contracts. */
export const parseConfigurationContract = (
  value: unknown,
): ConfigurationContract => {
  const invalid = () =>
    new Error(
      "Missing or malformed configuration contract; rebuild the organisation with Configuration version 1.",
    )
  if (
    !record(value) ||
    value["version"] !== 1 ||
    !Array.isArray(value["groups"])
  )
    throw invalid()
  const groups: ConfigurationGroup[] = []
  for (const group of value["groups"]) {
    if (
      !record(group) ||
      typeof group["owner"] !== "string" ||
      !group["owner"] ||
      typeof group["target"] !== "string" ||
      !group["target"] ||
      !record(group["fields"]) ||
      !Array.isArray(group["rules"])
    )
      throw invalid()
    const fields: Record<string, ConfigurationField> = {}
    for (const [name, field] of Object.entries(group["fields"])) {
      if (
        !record(field) ||
        typeof field["key"] !== "string" ||
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(field["key"]) ||
        typeof field["secret"] !== "boolean" ||
        (field["source"] !== "stage" && field["source"] !== "platform") ||
        !Config.isConfig(field["config"])
      )
        throw invalid()
      fields[name] = {
        key: field["key"],
        secret: field["secret"],
        source: field["source"],
        config: field["config"],
      }
    }
    const rules: ConfigurationGroup["rules"][number][] = []
    for (const rule of group["rules"]) {
      if (
        !record(rule) ||
        typeof rule["when"] !== "string" ||
        typeof rule["required"] !== "string" ||
        typeof rule["equals"] !== "boolean" ||
        !Object.hasOwn(fields, rule["when"]) ||
        !Object.hasOwn(fields, rule["required"])
      )
        throw invalid()
      rules.push({
        when: rule["when"],
        required: rule["required"],
        equals: rule["equals"],
      })
    }
    groups.push({
      owner: group["owner"],
      target: group["target"],
      fields,
      rules,
    })
  }
  return { version: 1, groups }
}

export const validateConfiguration = (
  contract: ConfigurationContract,
): Effect.Effect<readonly ConfigurationDiagnostic[]> =>
  Effect.forEach(contract.groups, (group) =>
    readConfiguration(group).pipe(
      Effect.as<readonly ConfigurationDiagnostic[]>([]),
      Effect.catchTag("ConfigurationError", (error) =>
        Effect.succeed(error.diagnostics),
      ),
    ),
  ).pipe(Effect.map((results) => results.flat()))
