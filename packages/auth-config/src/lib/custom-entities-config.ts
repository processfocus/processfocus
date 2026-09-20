import { Construct } from "constructs"

/**
 * Configuration for custom Cedar entity schemas.
 */
export interface CustomEntitiesConfigProps {
  /**
   * Paths to custom Cedar schema files, relative to the org package root.
   * These schemas are merged with the default schema at runtime.
   *
   * @example
   * ```typescript
   * new CustomEntitiesConfig(org, "custom-entities", {
   *   schemaFiles: ["cedar/custom.cedarschema"]
   * })
   * ```
   */
  readonly schemaFiles: readonly string[]
}

/**
 * Configuration for custom Cedar entity schemas.
 *
 * Attach this to an Organisation to specify custom Cedar schema files
 * that define additional entity types and actions beyond the built-in ones.
 *
 * ## Build-time vs Runtime
 *
 * At **build time** (`pfcli build`), `CustomEntitiesConfig` is used to identify
 * which schema files should be copied to the deployment artifact (dist/cedar/).
 *
 * At **runtime**, the GraphQL server reads schema files from the
 * `CEDAR_PATH` environment variable directory.
 *
 * @example
 * ```typescript
 * const org = new Organisation({ name: "Acme Corp" })
 *
 * new CustomEntitiesConfig(org, "custom-entities", {
 *   schemaFiles: ["cedar/custom.cedarschema"]
 * })
 * ```
 */
export class CustomEntitiesConfig extends Construct {
  readonly isCustomEntitiesConfig: true = true
  readonly schemaFiles: readonly string[]

  constructor(scope: Construct, id: string, props: CustomEntitiesConfigProps) {
    super(scope, id)
    this.schemaFiles = props.schemaFiles
  }
}

export const isCustomEntitiesConfig = (
  value: unknown,
): value is CustomEntitiesConfig =>
  typeof value === "object" &&
  value !== null &&
  "isCustomEntitiesConfig" in value &&
  value.isCustomEntitiesConfig === true
