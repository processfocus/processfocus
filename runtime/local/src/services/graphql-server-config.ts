import { existsSync, readFileSync } from "node:fs"
import { Config } from "effect"
import {
  DEFAULT_GRAPHQL_PORT,
  GRAPHQL_PORT_FILE,
  decodePortFromFileContent,
} from "./port-file"

export interface GraphqlPortFileReader {
  readonly existsSync: (path: string) => boolean
  readonly readFileSync: (path: string, encoding: BufferEncoding) => string
}

const defaultGraphqlPortFileReader: GraphqlPortFileReader = {
  existsSync,
  readFileSync: (path, encoding) => readFileSync(path, encoding),
}

/**
 * Reads the GraphQL port from the JSON port file in the current directory.
 * Returns default port if file doesn't exist or contains invalid content.
 *
 * @internal Exported for testing
 */
export const readGraphqlPort = (
  reader: GraphqlPortFileReader = defaultGraphqlPortFileReader,
): number => {
  if (!reader.existsSync(GRAPHQL_PORT_FILE)) {
    return DEFAULT_GRAPHQL_PORT
  }
  try {
    const content = reader.readFileSync(GRAPHQL_PORT_FILE, "utf-8")
    return decodePortFromFileContent(content) ?? DEFAULT_GRAPHQL_PORT
  } catch {
    return DEFAULT_GRAPHQL_PORT
  }
}

/**
 * Config provider for GraphQL server base URL.
 *
 * First checks GRAPHQL_SERVER_URL env var, then falls back to reading
 * from .graphql-port.json file and constructing http://localhost:{port}.
 */
export const GraphqlServerUrl = Config.string("GRAPHQL_SERVER_URL").pipe(
  Config.orElse(() =>
    Config.sync(() => {
      const port = readGraphqlPort()
      return `http://localhost:${port}`
    }),
  ),
)
