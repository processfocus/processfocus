import type { CodegenConfig } from "@graphql-codegen/cli"

const config: CodegenConfig = {
  schema: "./graphql/*.graphql",
  generates: {
    "src/generated/types.generated.ts": {
      plugins: [
        "typescript",
        "typescript-resolvers",
        {
          add: {
            content: [
              'import type { Effect } from "effect"',
              'import type { GraphqlResolverError } from "../errors"',
            ],
          },
        },
      ],
      config: {
        useTypeImports: true,
        customResolverFn:
          "(parent: TParent, args: TArgs, context: TContext, info: GraphQLResolveInfo) => Effect.Effect<TResult, GraphqlResolverError, unknown>",
      },
    },
  },
}
export default config
