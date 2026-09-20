import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  DatabaseDownloadSession,
  DnsRecords,
  GetRuntimeLogs,
  ListProjectEnvironments,
  ListProjects,
  StartDeploy,
} from "./schema.js"

describe("hosting contract operation documents", () => {
  it("decodes a listProjects response", async () => {
    const decoded = await Schema.decodeUnknownPromise(ListProjects)({
      listProjects: {
        items: [{ projectNumber: "0001-0001-0001", projectName: "Demo" }],
        totalCount: 1,
      },
    })
    expect(decoded.listProjects.items[0]?.projectName).toBe("Demo")
  })

  it("decodes a start deploy response", async () => {
    const decoded = await Schema.decodeUnknownPromise(StartDeploy)({
      startOperationsDeploy: {
        executionId: "exec-1",
        processPath: "/operations/deploy",
      },
    })
    expect(decoded.startOperationsDeploy.executionId).toBe("exec-1")
  })

  it("decodes DNS records used by deploy and custom-domain commands", async () => {
    const decoded = await Schema.decodeUnknownPromise(DnsRecords)({
      getDnsRecords: {
        frontendUrl: "https://example.processfocus.com",
        frontendUrlNote: null,
        customDomain: "app.example.com",
        certificateStatus: "ISSUED",
        warnings: [],
        validationRecords: [
          { type: "CNAME", name: "app", value: "target", purpose: "verify" },
        ],
        validationNote: null,
        siteAccessRecord: null,
        siteAccessNote: null,
        postscriptNotes: [],
      },
    })
    expect(decoded.getDnsRecords.customDomain).toBe("app.example.com")
  })

  it("decodes runtime logs", async () => {
    const decoded = await Schema.decodeUnknownPromise(GetRuntimeLogs)({
      getRuntimeLogs: {
        events: [{ timestamp: "2026-08-19T00:00:00Z", message: "ok" }],
      },
    })
    expect(decoded.getRuntimeLogs.events).toHaveLength(1)
  })

  it("decodes project environments", async () => {
    const decoded = await Schema.decodeUnknownPromise(ListProjectEnvironments)({
      listProjectEnvironments: {
        items: [{ environmentName: "dev", stageName: "development" }],
      },
    })
    expect(decoded.listProjectEnvironments.items[0]?.stageName).toBe(
      "development",
    )
  })

  it("decodes the authoritative database download engine", async () => {
    const decoded = await Schema.decodeUnknownPromise(DatabaseDownloadSession)({
      createDatabaseDownloadSession: {
        databaseUrl: "libsql://database.example.turso.io",
        authToken: "secret",
        databaseName: "database",
        engine: "tursodb",
        target: { stageName: "Production" },
      },
    })

    expect(decoded.createDatabaseDownloadSession.engine).toBe("tursodb")
  })
})
