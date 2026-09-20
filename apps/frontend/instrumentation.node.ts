import { getIssuerUrl, validateFrontendJwtIssuer } from "./lib/auth/client"
import { writeFrontendPortFileFromEnv } from "./lib/dev/frontend-port-file"
import { getGraphqlEndpoint } from "./lib/graphql/endpoint"

export async function register() {
  if (process.env.NODE_ENV === "development") {
    try {
      const port = writeFrontendPortFileFromEnv()

      if (port !== undefined) {
        console.log(`   - Frontend:      http://localhost:${port}`)
      }
    } catch (error) {
      console.warn("Failed to write .frontend-port.json:", error)
    }

    const graphqlEndpoint = getGraphqlEndpoint()
    const authServer = getIssuerUrl()

    console.log(`   - GraphQL:       ${graphqlEndpoint}`)
    console.log(`   - Auth:          ${authServer}`)

    validateFrontendJwtIssuer()
  }
}
