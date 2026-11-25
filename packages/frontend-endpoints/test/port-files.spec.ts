import { readFileSync } from "node:fs"
import {
  getAuthUrlFromPortFile,
  getEffectiveAuthUrl,
  getEffectiveFrontendBaseUrl,
  getEffectiveGraphqlEndpoint,
  getEffectiveWsEndpoint,
  getFrontendBaseUrlFromPortFile,
  getGraphqlEndpointFromPortFile,
  isLocalhostUrl,
  readGraphqlPort,
  shouldUsePortFiles,
} from "../src/port-files"
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"

mock.module("node:fs", () => ({
  readFileSync: mock(() => ""),
}))

describe("readGraphqlPort", () => {
  beforeEach(() => {
    const mockReadFileSync = readFileSync as ReturnType<typeof mock>
    mockReadFileSync.mockReset()
  })

  it("should return default port when file contains invalid JSON", () => {
    const mockReadFileSync = readFileSync as ReturnType<typeof mock>
    mockReadFileSync.mockImplementation(() => "invalid")

    expect(readGraphqlPort()).toBe(4000)
  })

  it("should return default port when port field is missing", () => {
    const mockReadFileSync = readFileSync as ReturnType<typeof mock>
    mockReadFileSync.mockImplementation(() => '{"other": 5000}')

    expect(readGraphqlPort()).toBe(4000)
  })

  it("reads port files from NX_WORKSPACE_ROOT when cwd is not the workspace", () => {
    const previousNx = process.env["NX_WORKSPACE_ROOT"]
    const previousRuntime = process.env["PF_RUNTIME_ROOT"]
    delete process.env["PF_RUNTIME_ROOT"]
    process.env["NX_WORKSPACE_ROOT"] = "/workspace"
    const mockReadFileSync = readFileSync as ReturnType<typeof mock>
    mockReadFileSync.mockImplementation((path: unknown) => {
      expect(String(path)).toBe("/workspace/.graphql-port.json")
      return '{"port": 4001}'
    })

    try {
      expect(readGraphqlPort()).toBe(4001)
    } finally {
      if (previousNx === undefined) delete process.env["NX_WORKSPACE_ROOT"]
      else process.env["NX_WORKSPACE_ROOT"] = previousNx
      if (previousRuntime === undefined) delete process.env["PF_RUNTIME_ROOT"]
      else process.env["PF_RUNTIME_ROOT"] = previousRuntime
    }
  })
})

describe("getGraphqlEndpointFromPortFile", () => {
  beforeEach(() => {
    const mockReadFileSync = readFileSync as ReturnType<typeof mock>
    mockReadFileSync.mockReset()
  })

  it("should return graphql endpoint with default port when file missing", () => {
    const mockReadFileSync = readFileSync as ReturnType<typeof mock>
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT")
    })

    expect(getGraphqlEndpointFromPortFile()).toBe(
      "http://localhost:4000/graphql",
    )
  })
})

describe("getAuthUrlFromPortFile", () => {
  beforeEach(() => {
    const mockReadFileSync = readFileSync as ReturnType<typeof mock>
    mockReadFileSync.mockReset()
  })

  it("should return auth url with default port when file missing", () => {
    const mockReadFileSync = readFileSync as ReturnType<typeof mock>
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT")
    })

    expect(getAuthUrlFromPortFile()).toBe("http://localhost:4020")
  })
})

describe("isLocalhostUrl", () => {
  it("should return true for http://127.0.0.1", () => {
    expect(isLocalhostUrl("http://127.0.0.1")).toBe(true)
  })

  it("should return true for http://127.0.0.1:4000", () => {
    expect(isLocalhostUrl("http://127.0.0.1:4000")).toBe(true)
  })

  it("should return false for invalid URL", () => {
    expect(isLocalhostUrl("not-a-url")).toBe(false)
  })
})

describe("shouldUsePortFiles", () => {
  const originalBaseUrl = process.env["BASE_URL"]
  const originalGraphqlEndpoint = process.env["GRAPHQL_ENDPOINT"]

  afterEach(() => {
    if (originalBaseUrl === undefined) {
      delete process.env["BASE_URL"]
    } else {
      process.env["BASE_URL"] = originalBaseUrl
    }
    if (originalGraphqlEndpoint === undefined) {
      delete process.env["GRAPHQL_ENDPOINT"]
    } else {
      process.env["GRAPHQL_ENDPOINT"] = originalGraphqlEndpoint
    }
  })

  it("should return false when GRAPHQL_ENDPOINT is set", () => {
    delete process.env["BASE_URL"]
    process.env["GRAPHQL_ENDPOINT"] = "http://localhost:5000/graphql"
    expect(shouldUsePortFiles()).toBe(false)
  })
})

describe("getEffectiveGraphqlEndpoint", () => {
  const originalBaseUrl = process.env["BASE_URL"]

  beforeEach(() => {
    const mockReadFileSync = readFileSync as ReturnType<typeof mock>
    mockReadFileSync.mockReset()
  })

  afterEach(() => {
    if (originalBaseUrl === undefined) {
      delete process.env["BASE_URL"]
    } else {
      process.env["BASE_URL"] = originalBaseUrl
    }
  })

  it("should use port file when BASE_URL=http://localhost", () => {
    process.env["BASE_URL"] = "http://localhost"
    const mockReadFileSync = readFileSync as ReturnType<typeof mock>
    mockReadFileSync.mockImplementation(() => '{"port": 5000}')

    expect(getEffectiveGraphqlEndpoint()).toBe("http://localhost:5000/graphql")
  })

  it("should use port file when BASE_URL=https://localhost", () => {
    process.env["BASE_URL"] = "https://localhost"
    const mockReadFileSync = readFileSync as ReturnType<typeof mock>
    mockReadFileSync.mockImplementation(() => '{"port": 5000}')

    expect(getEffectiveGraphqlEndpoint()).toBe("http://localhost:5000/graphql")
  })

  it("should use port file when BASE_URL is localhost with port", () => {
    process.env["BASE_URL"] = "http://localhost:3001"
    const mockReadFileSync = readFileSync as ReturnType<typeof mock>
    mockReadFileSync.mockImplementation(() => '{"port": 5000}')

    expect(getEffectiveGraphqlEndpoint()).toBe("http://localhost:5000/graphql")
  })

  it("should use standard endpoint when BASE_URL is a real URL", () => {
    process.env["BASE_URL"] = "https://api.example.com"
    const mockReadFileSync = readFileSync as ReturnType<typeof mock>
    mockReadFileSync.mockImplementation(() => '{"port": 5000}')

    expect(getEffectiveGraphqlEndpoint()).toBe(
      "https://api.example.com/graphql",
    )
  })

  it("should use port file when BASE_URL is not set", () => {
    delete process.env["BASE_URL"]
    const mockReadFileSync = readFileSync as ReturnType<typeof mock>
    mockReadFileSync.mockImplementation(() => '{"port": 5000}')

    // Without BASE_URL, use port files for local development
    expect(getEffectiveGraphqlEndpoint()).toBe("http://localhost:5000/graphql")
  })
})

describe("getEffectiveWsEndpoint", () => {
  const originalBaseUrl = process.env["BASE_URL"]

  beforeEach(() => {
    const mockReadFileSync = readFileSync as ReturnType<typeof mock>
    mockReadFileSync.mockReset()
  })

  afterEach(() => {
    if (originalBaseUrl === undefined) {
      delete process.env["BASE_URL"]
    } else {
      process.env["BASE_URL"] = originalBaseUrl
    }
  })

  it("should use port file when BASE_URL=http://localhost", () => {
    process.env["BASE_URL"] = "http://localhost"
    const mockReadFileSync = readFileSync as ReturnType<typeof mock>
    mockReadFileSync.mockImplementation(() => '{"port": 5000}')

    expect(getEffectiveWsEndpoint()).toBe("ws://localhost:5000/graphql")
  })

  it("should use standard endpoint when BASE_URL is a real URL", () => {
    process.env["BASE_URL"] = "https://api.example.com"
    const mockReadFileSync = readFileSync as ReturnType<typeof mock>
    mockReadFileSync.mockImplementation(() => '{"port": 5000}')

    expect(getEffectiveWsEndpoint()).toBe("wss://api.example.com/graphql")
  })
})

describe("getEffectiveAuthUrl", () => {
  const originalBaseUrl = process.env["BASE_URL"]

  beforeEach(() => {
    const mockReadFileSync = readFileSync as ReturnType<typeof mock>
    mockReadFileSync.mockReset()
  })

  afterEach(() => {
    if (originalBaseUrl === undefined) {
      delete process.env["BASE_URL"]
    } else {
      process.env["BASE_URL"] = originalBaseUrl
    }
  })

  it("should use port file when BASE_URL=http://localhost", () => {
    process.env["BASE_URL"] = "http://localhost"
    const mockReadFileSync = readFileSync as ReturnType<typeof mock>
    mockReadFileSync.mockImplementation(() => '{"port": 4025}')

    expect(getEffectiveAuthUrl()).toBe("http://localhost:4025")
  })

  it("should use standard endpoint when BASE_URL is a real URL", () => {
    process.env["BASE_URL"] = "https://api.example.com"
    const mockReadFileSync = readFileSync as ReturnType<typeof mock>
    mockReadFileSync.mockImplementation(() => '{"port": 4025}')

    expect(getEffectiveAuthUrl()).toBe("https://api.example.com")
  })
})

describe("getFrontendBaseUrlFromPortFile", () => {
  beforeEach(() => {
    const mockReadFileSync = readFileSync as ReturnType<typeof mock>
    mockReadFileSync.mockReset()
  })

  it("should return frontend base url with default port when file missing", () => {
    const mockReadFileSync = readFileSync as ReturnType<typeof mock>
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT")
    })

    expect(getFrontendBaseUrlFromPortFile()).toBe("http://localhost:3000")
  })
})

describe("getEffectiveFrontendBaseUrl", () => {
  const originalBaseUrl = process.env["BASE_URL"]
  const originalFrontendBaseUrl = process.env["FRONTEND_BASE_URL"]

  beforeEach(() => {
    const mockReadFileSync = readFileSync as ReturnType<typeof mock>
    mockReadFileSync.mockReset()
  })

  afterEach(() => {
    if (originalBaseUrl === undefined) {
      delete process.env["BASE_URL"]
    } else {
      process.env["BASE_URL"] = originalBaseUrl
    }

    if (originalFrontendBaseUrl === undefined) {
      delete process.env["FRONTEND_BASE_URL"]
    } else {
      process.env["FRONTEND_BASE_URL"] = originalFrontendBaseUrl
    }
  })

  it("should use port file when BASE_URL=http://localhost", () => {
    process.env["BASE_URL"] = "http://localhost"
    const mockReadFileSync = readFileSync as ReturnType<typeof mock>
    mockReadFileSync.mockImplementation(() => '{"port": 3005}')

    expect(getEffectiveFrontendBaseUrl()).toBe("http://localhost:3005")
  })

  it("should use port file when BASE_URL is not set", () => {
    delete process.env["BASE_URL"]
    const mockReadFileSync = readFileSync as ReturnType<typeof mock>
    mockReadFileSync.mockImplementation(() => '{"port": 3005}')

    expect(getEffectiveFrontendBaseUrl()).toBe("http://localhost:3005")
  })

  it("should use BASE_URL when BASE_URL is a real URL", () => {
    process.env["BASE_URL"] = "https://app.example.com"
    const mockReadFileSync = readFileSync as ReturnType<typeof mock>
    mockReadFileSync.mockImplementation(() => '{"port": 3005}')

    expect(getEffectiveFrontendBaseUrl()).toBe("https://app.example.com")
  })

  it("should prioritize FRONTEND_BASE_URL over BASE_URL", () => {
    process.env["FRONTEND_BASE_URL"] = "https://frontend.example.com"
    process.env["BASE_URL"] = "https://app.example.com"
    const mockReadFileSync = readFileSync as ReturnType<typeof mock>
    mockReadFileSync.mockImplementation(() => '{"port": 3005}')

    expect(getEffectiveFrontendBaseUrl()).toBe("https://frontend.example.com")
  })

  it("should use port file when FRONTEND_BASE_URL points to localhost", () => {
    process.env["FRONTEND_BASE_URL"] = "http://localhost"
    const mockReadFileSync = readFileSync as ReturnType<typeof mock>
    mockReadFileSync.mockImplementation(() => '{"port": 3005}')

    expect(getEffectiveFrontendBaseUrl()).toBe("http://localhost:3005")
  })
})
