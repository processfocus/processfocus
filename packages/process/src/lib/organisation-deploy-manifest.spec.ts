import { Construct } from "constructs"
import { Effect } from "effect"
import type { DayOfMonth } from "@pf/business-calendar"
import { Form } from "./form"
import { NodeStep } from "./node_step"
import { OrgUnit } from "./org-unit"
import { Organisation } from "./organisation"
import {
  ORGANISATION_DEPLOY_MANIFEST_VERSION,
  buildOrganisationDeployManifest,
  executorDescriptorsExtension,
  parseOrganisationDeployManifest,
} from "./organisation-deploy-manifest"
import { Process } from "./process"
import { Role } from "./role"
import { describe, expect, it } from "bun:test"

describe("organisation deploy manifest cron entries", () => {
  it("emits organisation-declared executor descriptors as an opaque extension", () => {
    const org = new Organisation({ name: "Test Org" })
    const unit = new OrgUnit(org, "ops", {
      name: "Operations",
      type: "department",
    })
    const step = new Construct(unit, "Execute") as Construct & {
      isDockerStep?: boolean
      dockerContext?: string
      dockerfile?: string
      command?: string
      executor?: unknown
    }
    step.isDockerStep = true
    step.dockerContext = "."
    step.dockerfile = "Dockerfile"
    step.command = "run task"
    step.executor = {
      id: "organisation/task",
      extensions: { "provider/task": { capability: "trusted-target" } },
    }

    const manifest = buildOrganisationDeployManifest({
      org,
      orgBundleSha256: "a".repeat(64),
    })

    expect(manifest.dockerSteps).toEqual([
      {
        stepPath: "/ops/Execute",
        dockerContext: ".",
        dockerfile: "Dockerfile",
        command: "run task",
      },
    ])
    expect(executorDescriptorsExtension(manifest)).toEqual({
      "/ops/Execute": {
        id: "organisation/task",
        extensions: { "provider/task": { capability: "trusted-target" } },
      },
    })
  })

  it("emits cron metadata for single-start system processes", () => {
    const org = new Organisation({
      name: "Test Org",
      timeZone: "Pacific/Auckland",
    })
    const unit = new OrgUnit(org, "ops", {
      name: "Operations",
      type: "department",
    })
    const process = new Process(unit, "nightly-sync", {
      name: "Nightly sync",
      purpose: "Run sync",
      cron: {
        type: "weekly",
        weekday: "monday",
        timeZone: "UTC",
        at: { hour: 9, minute: 30 },
      },
    })
    const start = new NodeStep(process, "Start sync", {
      input: () => Effect.void,
      output: {},
      execute: () => Effect.succeed({}),
    })

    process.start(start).end()

    const manifest = buildOrganisationDeployManifest({
      org,
      orgBundleSha256: "a".repeat(64),
    })

    expect(manifest.organisationTimeZone).toBe("Pacific/Auckland")
    expect(manifest.cronEntries).toEqual([
      {
        processPath: "/ops/nightly-sync",
        startMutationName: "startOpsNightlySync",
        cron: {
          type: "weekly",
          weekday: "monday",
          timeZone: "UTC",
          at: { hour: 9, minute: 30 },
        },
      },
    ])
  })

  it("rejects cron on non-system start steps", () => {
    const org = new Organisation({ name: "Test Org" })
    const unit = new OrgUnit(org, "ops", {
      name: "Operations",
      type: "department",
    })
    const role = new Role(unit, "manager", { name: "Manager" })
    const process = new Process(unit, "manual-sync", {
      name: "Manual sync",
      purpose: "Run sync",
      cron: {
        type: "daily",
        at: { hour: 9, minute: 0 },
      },
    })
    const start = new Form(process, "Start form", {
      role,
      form: () => ({}),
    })

    process.start(start).end()

    expect(() =>
      buildOrganisationDeployManifest({
        org,
        orgBundleSha256: "a".repeat(64),
      }),
    ).toThrow(
      "declares cron but start step /ops/manual-sync/Start form is not a system step",
    )
  })

  it("rejects cron on processes with multiple start steps", () => {
    const org = new Organisation({ name: "Test Org" })
    const unit = new OrgUnit(org, "ops", {
      name: "Operations",
      type: "department",
    })
    const process = new Process(unit, "split-start", {
      name: "Split start",
      purpose: "Run sync",
      cron: {
        type: "monthly",
        dayOfMonth: 15 as DayOfMonth,
        at: { hour: 9, minute: 0 },
      },
    })
    const startA = new NodeStep(process, "Start A", {
      input: () => Effect.void,
      output: {},
      execute: () => Effect.succeed({}),
    })
    const startB = new NodeStep(process, "Start B", {
      input: () => Effect.void,
      output: {},
      execute: () => Effect.succeed({}),
    })

    process.start(startA).end()
    process.start(startB).end()

    expect(() =>
      buildOrganisationDeployManifest({
        org,
        orgBundleSha256: "a".repeat(64),
      }),
    ).toThrow("declares cron but has 2 start steps")
  })

  it("rejects cron on processes with no start steps", () => {
    const org = new Organisation({ name: "Test Org" })
    const unit = new OrgUnit(org, "ops", {
      name: "Operations",
      type: "department",
    })
    new Process(unit, "unstarted-sync", {
      name: "Unstarted sync",
      purpose: "Run sync",
      cron: {
        type: "daily",
        at: { hour: 9, minute: 0 },
      },
    })

    expect(() =>
      buildOrganisationDeployManifest({
        org,
        orgBundleSha256: "a".repeat(64),
      }),
    ).toThrow("declares cron but has 0 start steps")
  })

  it("parses cron entries from manifest JSON", () => {
    const manifest = parseOrganisationDeployManifest({
      version: ORGANISATION_DEPLOY_MANIFEST_VERSION,
      orgBundleSha256: "a".repeat(64),
      organisationTimeZone: "UTC",
      awsFunctionNames: [],
      hasLongDurationSteps: false,
      dockerSteps: [],
      documentStores: [],
      cronEntries: [
        {
          processPath: "/ops/nightly-sync",
          startMutationName: "startOpsNightlySync",
          cron: {
            type: "monthly",
            dayOfMonth: 15 as DayOfMonth,
            timeZone: "Europe/Amsterdam",
            at: { hour: 9, minute: 30 },
          },
        },
      ],
    })

    expect(manifest.cronEntries).toEqual([
      {
        processPath: "/ops/nightly-sync",
        startMutationName: "startOpsNightlySync",
        cron: {
          type: "monthly",
          dayOfMonth: 15 as DayOfMonth,
          timeZone: "Europe/Amsterdam",
          at: { hour: 9, minute: 30 },
        },
      },
    ])
    expect(manifest.organisationTimeZone).toBe("UTC")
  })

  it("parses hourly cron entries from manifest JSON", () => {
    const manifest = parseOrganisationDeployManifest({
      version: ORGANISATION_DEPLOY_MANIFEST_VERSION,
      orgBundleSha256: "a".repeat(64),
      organisationTimeZone: "UTC",
      awsFunctionNames: [],
      hasLongDurationSteps: false,
      dockerSteps: [],
      documentStores: [],
      cronEntries: [
        {
          processPath: "/ops/log-check",
          startMutationName: "startOpsLogCheck",
          cron: {
            type: "hourly",
            minute: 0,
            timeZone: "UTC",
          },
        },
      ],
    })

    expect(manifest.cronEntries).toEqual([
      {
        processPath: "/ops/log-check",
        startMutationName: "startOpsLogCheck",
        cron: {
          type: "hourly",
          minute: 0,
          timeZone: "UTC",
        },
      },
    ])
  })

  it("rejects invalid cron entry time zones", () => {
    expect(() =>
      parseOrganisationDeployManifest({
        version: ORGANISATION_DEPLOY_MANIFEST_VERSION,
        orgBundleSha256: "a".repeat(64),
        organisationTimeZone: "UTC",
        awsFunctionNames: [],
        hasLongDurationSteps: false,
        dockerSteps: [],
        documentStores: [],
        cronEntries: [
          {
            processPath: "/ops/log-check",
            startMutationName: "startOpsLogCheck",
            cron: {
              type: "hourly",
              minute: 0,
              timeZone: "Invalid/Zone",
            },
          },
        ],
      }),
    ).toThrow('Invalid timezone: "Invalid/Zone"')
  })

  it("rejects invalid hourly cron minute values", () => {
    expect(() =>
      parseOrganisationDeployManifest({
        version: ORGANISATION_DEPLOY_MANIFEST_VERSION,
        orgBundleSha256: "a".repeat(64),
        organisationTimeZone: "UTC",
        awsFunctionNames: [],
        hasLongDurationSteps: false,
        dockerSteps: [],
        documentStores: [],
        cronEntries: [
          {
            processPath: "/ops/log-check",
            startMutationName: "startOpsLogCheck",
            cron: {
              type: "hourly",
              minute: 60,
            },
          },
        ],
      }),
    ).toThrow("cronEntries[0].cron.minute must be between 0 and 59")

    expect(() =>
      parseOrganisationDeployManifest({
        version: ORGANISATION_DEPLOY_MANIFEST_VERSION,
        orgBundleSha256: "a".repeat(64),
        organisationTimeZone: "UTC",
        awsFunctionNames: [],
        hasLongDurationSteps: false,
        dockerSteps: [],
        documentStores: [],
        cronEntries: [
          {
            processPath: "/ops/log-check",
            startMutationName: "startOpsLogCheck",
            cron: {
              type: "hourly",
              minute: -1,
            },
          },
        ],
      }),
    ).toThrow("cronEntries[0].cron.minute must be between 0 and 59")
  })

  it("treats null cron entries as absent", () => {
    const manifest = parseOrganisationDeployManifest({
      version: ORGANISATION_DEPLOY_MANIFEST_VERSION,
      orgBundleSha256: "a".repeat(64),
      organisationTimeZone: "UTC",
      awsFunctionNames: [],
      hasLongDurationSteps: false,
      dockerSteps: [],
      documentStores: [],
      cronEntries: null,
    })

    expect(manifest.cronEntries).toEqual([])
  })

  it("rejects invalid organisation time zones", () => {
    expect(() =>
      parseOrganisationDeployManifest({
        version: ORGANISATION_DEPLOY_MANIFEST_VERSION,
        orgBundleSha256: "a".repeat(64),
        organisationTimeZone: "Mars/Base",
        awsFunctionNames: [],
        hasLongDurationSteps: false,
        dockerSteps: [],
        documentStores: [],
      }),
    ).toThrow('Invalid timezone: "Mars/Base"')
  })

  it("rejects malformed executor descriptor extensions", () => {
    for (const value of [null, "invalid", []]) {
      expect(() =>
        parseOrganisationDeployManifest({
          version: ORGANISATION_DEPLOY_MANIFEST_VERSION,
          orgBundleSha256: "a".repeat(64),
          organisationTimeZone: "UTC",
          hasLongDurationSteps: false,
          dockerSteps: [],
          documentStores: [],
          extensions: { "processfocus/executors": value },
        }),
      ).toThrow("extensions.processfocus/executors must be an object")
    }
  })
})
