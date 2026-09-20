import type { CodegenConfig } from "@graphql-codegen/cli"

const config: CodegenConfig = {
  schema: "../../packages/graphql-schema/graphql/*.graphql",
  documents: ["lib/**/*.ts"],
  generates: {
    "./lib/generated/gql/": {
      preset: "client-preset",
      config: {
        useTypeImports: true,
        skipTypename: true,
        scalars: {
          DateTimeISO: "string",
        },
      },
    },
  },
}
export default config
