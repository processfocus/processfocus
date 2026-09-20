import { Effect } from "effect"
import { buildDynamicSchema } from "@pf/org-to-graphql-schema"
import {
  type CustomGraphqlSchemaDefinition,
  type Organisation,
  OrganisationProviderTest,
} from "@pf/process"

/**
 * Generate schema inside the bundled organisation's JavaScript realm.
 *
 * Keeping the schema walker beside the organisation means plugin-owned field
 * modules register against the same runtime registry that projects them.
 */
export const buildBundledGraphqlSchema = (
  organisation: Organisation,
  orgPath: string,
  customGraphqlSchema: CustomGraphqlSchemaDefinition | undefined,
): Promise<string> =>
  Effect.runPromise(
    buildDynamicSchema().pipe(
      Effect.provide(
        OrganisationProviderTest(
          organisation,
          orgPath,
          undefined,
          customGraphqlSchema,
        ),
      ),
    ),
  )
