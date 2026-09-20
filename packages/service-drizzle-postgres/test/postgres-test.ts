import { Layer } from "effect"
import { TypedPostgresDrizzleLayer } from "../src/lib/typed-drizzle"
import { MigrationLayer } from "./migrator"
import { PgContainer } from "./postgres-alpine-container"

// Use provideMerge to preserve SqlClient from PgContainer.ClientLive
// This ensures SqlClient is available for sql.withTransaction()
const DrizzleLayer = TypedPostgresDrizzleLayer.pipe(
  Layer.provideMerge(PgContainer.ClientLive),
)

export const PostgresTest = MigrationLayer.pipe(
  Layer.provideMerge(DrizzleLayer),
)
