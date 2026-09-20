import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { findForbiddenDashboardClientChunkMatches } from "../scripts/assert-dashboard-client-chunks"
import { afterEach, describe, expect, test } from "bun:test"

let tempDir: string | undefined

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true })
  tempDir = undefined
})

describe("Dashboard client chunk guard", () => {
  test("allows trusted plugin client chunks", () => {
    tempDir = mkdtempSync(join(tmpdir(), "dashboard-chunks-clean-"))
    mkdirSync(join(tempDir, ".next/static/chunks"), { recursive: true })
    writeFileSync(
      join(tempDir, ".next/static/chunks/posthog.js"),
      'import("posthog-js"); export const type = "analytics.posthog"\n',
    )

    expect(findForbiddenDashboardClientChunkMatches(tempDir)).toEqual([])
  })

  test("reports AWS SDK, CDK, database, worker, and cloud backend modules", () => {
    tempDir = mkdtempSync(join(tmpdir(), "dashboard-chunks-dirty-"))
    mkdirSync(join(tempDir, ".next/static/chunks"), { recursive: true })
    mkdirSync(join(tempDir, ".open-next/assets"), { recursive: true })
    writeFileSync(
      join(tempDir, ".next/static/chunks/aws.js"),
      'import("@aws-sdk/client-ssm")\n',
    )
    writeFileSync(
      join(tempDir, ".open-next/assets/backend.js"),
      'export const path = "cloud/org/src/schema/schema.ts"\n',
    )
    writeFileSync(
      join(tempDir, ".next/static/chunks/worker.js"),
      'import("./job-worker.js")\nimport("drizzle-orm")\nimport("aws-cdk-lib")\n',
    )

    expect(
      findForbiddenDashboardClientChunkMatches(tempDir)
        .map((match) => `${match.file}:${match.id}`)
        .sort(),
    ).toEqual([
      ".next/static/chunks/aws.js:aws-sdk",
      ".next/static/chunks/worker.js:aws-cdk",
      ".next/static/chunks/worker.js:drizzle",
      ".next/static/chunks/worker.js:job-worker",
      ".open-next/assets/backend.js:cloud-backend",
    ])
  })
})
