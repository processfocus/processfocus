import {
  getAuthUrl,
  getFrontendBaseUrl,
  getGraphqlEndpoint,
  getGraphqlServerBaseUrl,
  getWsEndpoint,
} from "../src/endpoint"
import { beforeEach, describe, expect, it } from "bun:test"

describe("getGraphqlEndpoint", () => {
  const originalEnv = process.env

  beforeEach(() => {
    // Reset environment before each test
    process.env = { ...originalEnv }
    delete process.env["BASE_URL"]
    delete process.env["GRAPHQL_ENDPOINT"]
    delete process.env["NODE_ENV"]
    delete process.env["NX_WORKSPACE_ROOT"]
  })

  it("should return BASE_URL + /graphql when BASE_URL is set", () => {
    process.env["BASE_URL"] = "https://example.cloudfront.net"
    expect(getGraphqlEndpoint()).toBe("https://example.cloudfront.net/graphql")
  })

  it("should prioritize BASE_URL over GRAPHQL_ENDPOINT", () => {
    process.env["BASE_URL"] = "https://example.cloudfront.net"
    process.env["GRAPHQL_ENDPOINT"] = "http://custom.com/graphql"
    expect(getGraphqlEndpoint()).toBe("https://example.cloudfront.net/graphql")
  })

  it("should return GRAPHQL_ENDPOINT when set", () => {
    process.env["GRAPHQL_ENDPOINT"] = "http://custom.com/graphql"
    expect(getGraphqlEndpoint()).toBe("http://custom.com/graphql")
  })

  it("should return localhost with default port in development", () => {
    process.env["NODE_ENV"] = "development"
    expect(getGraphqlEndpoint()).toBe("http://localhost:4000/graphql")
  })

  it("should return localhost with default port when NODE_ENV is not set", () => {
    expect(getGraphqlEndpoint()).toBe("http://localhost:4000/graphql")
  })

  it("should return localhost fallback in production when GRAPHQL_ENDPOINT is not set", () => {
    process.env["NODE_ENV"] = "production"
    expect(getGraphqlEndpoint()).toBe("http://localhost:4000/graphql")
  })
})

describe("getWsEndpoint", () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
    delete process.env["BASE_URL"]
    delete process.env["NEXT_PUBLIC_WS_ENDPOINT"]
    delete process.env["GRAPHQL_ENDPOINT"]
    delete process.env["NODE_ENV"]
  })

  it("should return wss endpoint when BASE_URL is https", () => {
    process.env["BASE_URL"] = "https://example.cloudfront.net"
    expect(getWsEndpoint()).toBe("wss://example.cloudfront.net/graphql")
  })

  it("should return ws endpoint when BASE_URL is http", () => {
    process.env["BASE_URL"] = "http://example.com"
    expect(getWsEndpoint()).toBe("ws://example.com/graphql")
  })

  it("should prioritize BASE_URL over NEXT_PUBLIC_WS_ENDPOINT", () => {
    process.env["BASE_URL"] = "https://example.cloudfront.net"
    process.env["NEXT_PUBLIC_WS_ENDPOINT"] = "ws://custom.com/ws"
    expect(getWsEndpoint()).toBe("wss://example.cloudfront.net/graphql")
  })

  it("should return NEXT_PUBLIC_WS_ENDPOINT when set", () => {
    process.env["NEXT_PUBLIC_WS_ENDPOINT"] = "ws://custom.com/ws"
    expect(getWsEndpoint()).toBe("ws://custom.com/ws")
  })

  it("should derive ws endpoint from graphql endpoint", () => {
    process.env["GRAPHQL_ENDPOINT"] = "http://api.com/graphql"
    expect(getWsEndpoint()).toBe("ws://api.com/graphql")
  })

  it("should convert https to wss", () => {
    process.env["GRAPHQL_ENDPOINT"] = "https://api.com/graphql"
    expect(getWsEndpoint()).toBe("wss://api.com/graphql")
  })

  it("should use localhost in development", () => {
    process.env["NODE_ENV"] = "development"
    expect(getWsEndpoint()).toBe("ws://localhost:4000/graphql")
  })

  it("should prioritize NEXT_PUBLIC_WS_ENDPOINT over derived endpoint", () => {
    process.env["NEXT_PUBLIC_WS_ENDPOINT"] = "ws://custom-ws.com"
    process.env["GRAPHQL_ENDPOINT"] = "http://api.com/graphql"
    expect(getWsEndpoint()).toBe("ws://custom-ws.com")
  })
})

describe("getGraphqlServerBaseUrl", () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
    delete process.env["BASE_URL"]
    delete process.env["GRAPHQL_ENDPOINT"]
    delete process.env["NODE_ENV"]
  })

  it("should return BASE_URL when set", () => {
    process.env["BASE_URL"] = "https://example.cloudfront.net"
    expect(getGraphqlServerBaseUrl()).toBe("https://example.cloudfront.net")
  })

  it("should prioritize BASE_URL over GRAPHQL_ENDPOINT", () => {
    process.env["BASE_URL"] = "https://example.cloudfront.net"
    process.env["GRAPHQL_ENDPOINT"] = "http://api.com/graphql"
    expect(getGraphqlServerBaseUrl()).toBe("https://example.cloudfront.net")
  })

  it("should return base URL when GRAPHQL_ENDPOINT is set", () => {
    process.env["GRAPHQL_ENDPOINT"] = "http://api.com/graphql"
    expect(getGraphqlServerBaseUrl()).toBe("http://api.com")
  })

  it("should handle GRAPHQL_ENDPOINT without /graphql suffix", () => {
    process.env["GRAPHQL_ENDPOINT"] = "http://api.com"
    expect(getGraphqlServerBaseUrl()).toBe("http://api.com")
  })

  it("should return localhost fallback in production when GRAPHQL_ENDPOINT is not set", () => {
    process.env["NODE_ENV"] = "production"
    expect(getGraphqlServerBaseUrl()).toBe("http://localhost:4000")
  })

  it("should return localhost with default port in development", () => {
    process.env["NODE_ENV"] = "development"
    expect(getGraphqlServerBaseUrl()).toBe("http://localhost:4000")
  })
})

describe("getAuthUrl", () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
    delete process.env["BASE_URL"]
    delete process.env["AUTH_URL"]
  })

  it("should return BASE_URL when set", () => {
    process.env["BASE_URL"] = "https://example.cloudfront.net"
    expect(getAuthUrl()).toBe("https://example.cloudfront.net")
  })

  it("should prioritize BASE_URL over AUTH_URL", () => {
    process.env["BASE_URL"] = "https://example.cloudfront.net"
    process.env["AUTH_URL"] = "http://custom-auth.com"
    expect(getAuthUrl()).toBe("https://example.cloudfront.net")
  })

  it("should return AUTH_URL when set", () => {
    process.env["AUTH_URL"] = "http://custom-auth.com"
    expect(getAuthUrl()).toBe("http://custom-auth.com")
  })

  it("should return default localhost URL when AUTH_URL is not set", () => {
    expect(getAuthUrl()).toBe("http://localhost:4020")
  })

  it("should handle custom port in AUTH_URL", () => {
    process.env["AUTH_URL"] = "http://localhost:8080"
    expect(getAuthUrl()).toBe("http://localhost:8080")
  })
})

describe("getFrontendBaseUrl", () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv }
    delete process.env["FRONTEND_BASE_URL"]
    delete process.env["BASE_URL"]
  })

  it("should return FRONTEND_BASE_URL when set", () => {
    process.env["FRONTEND_BASE_URL"] = "https://frontend.example.com"

    expect(getFrontendBaseUrl()).toBe("https://frontend.example.com")
  })

  it("should prioritize FRONTEND_BASE_URL over BASE_URL", () => {
    process.env["FRONTEND_BASE_URL"] = "https://frontend.example.com"
    process.env["BASE_URL"] = "https://api.example.com"

    expect(getFrontendBaseUrl()).toBe("https://frontend.example.com")
  })

  it("should fall back to BASE_URL when FRONTEND_BASE_URL is unset", () => {
    process.env["BASE_URL"] = "https://api.example.com"

    expect(getFrontendBaseUrl()).toBe("https://api.example.com")
  })
})
