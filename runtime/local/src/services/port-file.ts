import { Schema } from "effect"

/**
 * Default GraphQL server port when none is configured and no port file exists.
 */
export const DEFAULT_GRAPHQL_PORT = 4000

/**
 * Filename written by the local GraphQL server for service discovery.
 * Consumers (job worker, config readers) import this file or watch it via
 * bun --watch so they pick up fallback ports.
 */
export const GRAPHQL_PORT_FILE = ".graphql-port.json"

/**
 * Port file JSON structure shared by GraphQL, auth, and frontend port files.
 */
const PortFileContentStruct = Schema.Struct({ port: Schema.Number })

/**
 * JSON string schema for port-file payloads: `{"port": number}`.
 */
export const PortFileContentJson = Schema.parseJson(PortFileContentStruct)

export type PortFileContent = Schema.Schema.Type<typeof PortFileContentStruct>

/**
 * Decodes a port number from port-file JSON content.
 * Returns undefined when the content is missing or invalid.
 */
export const decodePortFromFileContent = (
  content: string,
): number | undefined => {
  try {
    return Schema.decodeUnknownSync(PortFileContentJson)(content).port
  } catch {
    return undefined
  }
}
