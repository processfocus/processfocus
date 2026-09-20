import { Construct } from "constructs"

/**
 * Configuration for custom Cedar authorization policies.
 */
export interface PoliciesConfigProps {
  /**
   * Paths to custom Cedar policy files, relative to the org package root.
   * These policies are merged with the default policies at runtime.
   *
   * @example
   * ```typescript
   * new PoliciesConfig(org, "policies", {
   *   policyFiles: ["cedar/custom.cedar", "cedar/admin.cedar"]
   * })
   * ```
   */
  readonly policyFiles: readonly string[]
}

/**
 * Configuration for custom Cedar authorization policies.
 *
 * Attach this to an Organisation to specify custom Cedar policy files
 * that will be loaded and merged with the default policies at runtime.
 *
 * ## Build-time vs Runtime
 *
 * At **build time** (`pfcli build`), `PoliciesConfig` is used to identify which
 * policy files should be copied to the deployment artifact (dist/cedar/).
 *
 * At **runtime**, the GraphQL server and other services read policies from the
 * `CEDAR_PATH` environment variable, which points to the directory
 * where policies were deployed.
 *
 * @example
 * ```typescript
 * const org = new Organisation({ name: "Acme Corp" })
 *
 * new PoliciesConfig(org, "policies", {
 *   policyFiles: ["cedar/custom.cedar"]
 * })
 * ```
 *
 * Note: `PoliciesConfig` must be attached directly to the org module
 * that is loaded at build time (src/index.ts), otherwise the policy
 * files will not be discovered and copied to the deployment artifact.
 */
export class PoliciesConfig extends Construct {
  readonly isPoliciesConfig: true = true
  readonly policyFiles: readonly string[]

  constructor(scope: Construct, id: string, props: PoliciesConfigProps) {
    super(scope, id)
    this.policyFiles = props.policyFiles
  }
}

export const isPoliciesConfig = (value: unknown): value is PoliciesConfig =>
  typeof value === "object" &&
  value !== null &&
  "isPoliciesConfig" in value &&
  value.isPoliciesConfig === true
