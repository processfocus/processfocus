import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { ConfigProvider, Effect } from "effect"
import {
  type GraphqlPortFileReader,
  GraphqlServerUrl,
  readGraphqlPort,
} from "./graphql-server-config"
import { DEFAULT_GRAPHQL_PORT, GRAPHQL_PORT_FILE } from "./port-file"
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"

const originalPortFile = existsSync(GRAPHQL_PORT_FILE)
  ? readFileSync(GRAPHQL_PORT_FILE, "utf-8")
  : undefined

const mockExistsSync = mock(() => true)
const mockReadFileSync = mock((_path: string, _encoding: BufferEncoding) => "")

const portFileReader: GraphqlPortFileReader = {
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
}

const restorePortFile = () => {
  if (originalPortFile === undefined) {
    if (existsSync(GRAPHQL_PORT_FILE)) {
      unlinkSync(GRAPHQL_PORT_FILE)
    }
    return
  }

  writeFileSync(GRAPHQL_PORT_FILE, originalPortFile)
}

describe("readGraphqlPort", () => {
  beforeEach(() => {
    mockExistsSync.mockReset()
    mockReadFileSync.mockReset()
    mockExistsSync.mockImplementation(() => true)
    mockReadFileSync.mockImplementation(() => "")
  })

  it("should read port from valid JSON file", () => {
    mockReadFileSync.mockImplementation(() => '{"port": 5000}')

    expect(readGraphqlPort(portFileReader)).toBe(5000)
  })

  it("should return default port when file doesn't exist", () => {
    mockExistsSync.mockImplementation(() => false)

    expect(readGraphqlPort(portFileReader)).toBe(DEFAULT_GRAPHQL_PORT)
  })

  it("should return default port when file contains invalid JSON", () => {
    mockReadFileSync.mockImplementation(() => "not valid json")

    expect(readGraphqlPort(portFileReader)).toBe(DEFAULT_GRAPHQL_PORT)
  })

  it("should return default port when port field is missing", () => {
    mockReadFileSync.mockImplementation(() => '{"other": 5000}')

    expect(readGraphqlPort(portFileReader)).toBe(DEFAULT_GRAPHQL_PORT)
  })

  it("should return default port when port is a string instead of number", () => {
    mockReadFileSync.mockImplementation(() => '{"port": "4000"}')

    expect(readGraphqlPort(portFileReader)).toBe(DEFAULT_GRAPHQL_PORT)
  })

  it("should return default port when port is null", () => {
    mockReadFileSync.mockImplementation(() => '{"port": null}')

    expect(readGraphqlPort(portFileReader)).toBe(DEFAULT_GRAPHQL_PORT)
  })

  it("should return default port when JSON is empty object", () => {
    mockReadFileSync.mockImplementation(() => "{}")

    expect(readGraphqlPort(portFileReader)).toBe(DEFAULT_GRAPHQL_PORT)
  })

  it("should return default port when readFileSync throws", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory")
    })

    expect(readGraphqlPort(portFileReader)).toBe(DEFAULT_GRAPHQL_PORT)
  })
})

describe("GraphqlServerUrl Config", () => {
  const originalEnv = process.env["GRAPHQL_SERVER_URL"]

  beforeEach(() => {
    restorePortFile()
  })

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env["GRAPHQL_SERVER_URL"]
    } else {
      process.env["GRAPHQL_SERVER_URL"] = originalEnv
    }

    restorePortFile()
  })

  it("should use GRAPHQL_SERVER_URL env var when set", async () => {
    const provider = ConfigProvider.fromMap(
      new Map([["GRAPHQL_SERVER_URL", "https://api.example.com"]]),
    )
    const program = Effect.withConfigProvider(GraphqlServerUrl, provider)

    const url = await Effect.runPromise(program)
    expect(url).toBe("https://api.example.com")
  })

  it("should fall back to port file when env var not set", async () => {
    writeFileSync(GRAPHQL_PORT_FILE, '{"port": 5000}')

    const provider = ConfigProvider.fromMap(new Map())
    const program = Effect.withConfigProvider(GraphqlServerUrl, provider)

    const url = await Effect.runPromise(program)
    expect(url).toBe("http://localhost:5000")
  })

  it("should use default port when file doesn't exist and env not set", async () => {
    if (existsSync(GRAPHQL_PORT_FILE)) {
      unlinkSync(GRAPHQL_PORT_FILE)
    }

    const provider = ConfigProvider.fromMap(new Map())
    const program = Effect.withConfigProvider(GraphqlServerUrl, provider)

    const url = await Effect.runPromise(program)
    expect(url).toBe(`http://localhost:${DEFAULT_GRAPHQL_PORT}`)
  })
})
