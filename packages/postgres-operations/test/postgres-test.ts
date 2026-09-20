import { inject } from "vitest"
import {
  TypedPostgresDrizzle,
  postgresTestFromTemplate,
} from "@pf/service-drizzle-postgres/test"

export { TypedPostgresDrizzle }

export const PostgresTest = postgresTestFromTemplate(
  inject("postgresTestSuite"),
)
