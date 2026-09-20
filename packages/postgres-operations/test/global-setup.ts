import { Effect, Exit, Scope } from "effect"
import type { TestProject } from "vitest/node"
import {
  PostgresTestSuite,
  type PostgresTestSuiteConfig,
} from "@pf/service-drizzle-postgres/test"

declare module "vitest" {
  export interface ProvidedContext {
    postgresTestSuite: PostgresTestSuiteConfig
  }
}

export default async function setup(project: TestProject) {
  const scope = await Effect.runPromise(Scope.make())

  try {
    const config = await Effect.runPromise(
      PostgresTestSuite.pipe(Effect.provideService(Scope.Scope, scope)),
    )
    project.provide("postgresTestSuite", config)
  } catch (error) {
    await Effect.runPromise(Scope.close(scope, Exit.void))
    throw error
  }

  return () => Effect.runPromise(Scope.close(scope, Exit.void))
}
