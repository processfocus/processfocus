import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import {
  captureStdout,
  loadPfcliCommand,
  runPfcliInProcess,
  useSerializedTestState,
} from "./test-helpers"
import { afterEach, describe, expect, it } from "bun:test"

type RunCustomDomain = (
  projectId: string,
  environmentId: string,
) => Effect.Effect<void, unknown>

const loadRunCustomDomain = async (): Promise<RunCustomDomain> => {
  const module = await loadPfcliCommand<{
    runCustomDomain: RunCustomDomain
  }>("custom-domain")

  return module.runCustomDomain
}

const createCredentialsFile = (baseDir: string, baseUrl: string) => {
  const credentialsPath = join(baseDir, "credentials.json")
  writeFileSync(
    credentialsPath,
    JSON.stringify(
      {
        version: 1,
        baseUrl,
        accessToken: "test-token",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        loginAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  )
  return credentialsPath
}

useSerializedTestState()

describe("pfcli custom-domain", () => {
  const tempPaths: string[] = []
  const originalFetch = globalThis.fetch
  const originalCredPath = process.env["PFCLI_CREDENTIALS_PATH"]

  const isCustomDomainError = (
    value: unknown,
  ): value is { _tag: string; message: string } =>
    typeof value === "object" &&
    value !== null &&
    "_tag" in value &&
    "message" in value

  afterEach(() => {
    for (const tempPath of tempPaths) {
      rmSync(tempPath, { recursive: true, force: true })
    }
    tempPaths.length = 0
    globalThis.fetch = originalFetch
    if (originalCredPath === undefined) {
      delete process.env["PFCLI_CREDENTIALS_PATH"]
    } else {
      process.env["PFCLI_CREDENTIALS_PATH"] = originalCredPath
    }
  })

  it("prints DNS records returned by the console GraphQL API", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-custom-domain-"))
    tempPaths.push(testDir)

    process.env["PFCLI_CREDENTIALS_PATH"] = createCredentialsFile(
      testDir,
      "http://mocked.test",
    )

    globalThis.fetch = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const body = JSON.parse(String(init?.body)) as {
        variables?: { projectId?: string; environmentId?: string }
      }

      expect(body.variables).toEqual({
        projectId: "0000-0000-0002",
        environmentId: "prod",
      })

      return new Response(
        JSON.stringify({
          data: {
            getDnsRecords: {
              defaultDomain: "prod.0000-0000-0002.app.processfocus.com",
              frontendUrl: "https://prod.0000-0000-0002.app.processfocus.com",
              frontendUrlNote:
                "custom domain is not live yet; keep using the default app domain until validation completes and you redeploy.",
              customDomain: "app.customer.example",
              certificateStatus: "PENDING_VALIDATION",
              warnings: [
                "Warning: ACM certificate has multiple possible custom domains: app.customer.example, admin.customer.example",
                "Set SSM parameter /pf-0000-0000-0002/env/prod/custom-domain to disambiguate.",
              ],
              validationRecords: [
                {
                  type: "CNAME",
                  name: "_abc.app.customer.example.",
                  value: "_xyz.acm-validations.aws.",
                  purpose: "cert validation",
                },
              ],
              validationNote: null,
              siteAccessRecord: {
                type: "CNAME",
                name: "app.customer.example",
                value: "d111111abcdef8.cloudfront.net",
                purpose: "site access",
              },
              siteAccessNote: null,
              postscriptNotes: [
                "Once validation completes, re-deploy to enable the custom domain alias.",
              ],
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }) as unknown as typeof fetch

    const runCustomDomain = await loadRunCustomDomain()
    const { output } = await captureStdout(() =>
      Effect.runPromise(runCustomDomain("0000-0000-0002", "prod")),
    )

    expect(output).toContain(
      "Warning: ACM certificate has multiple possible custom domains",
    )
    expect(output).toContain(
      "Set SSM parameter /pf-0000-0000-0002/env/prod/custom-domain to disambiguate.",
    )
    expect(output).toContain("Custom domain: app.customer.example")
    expect(output).toContain("Status: PENDING_VALIDATION")
    expect(output).toContain(
      "Frontend URL: https://prod.0000-0000-0002.app.processfocus.com",
    )
    expect(output).toContain(
      "Note: custom domain is not live yet; keep using the default app domain until validation completes and you redeploy.",
    )
    expect(output).toContain(
      "CNAME _abc.app.customer.example. -> _xyz.acm-validations.aws.  (cert validation)",
    )
    expect(output).toContain(
      "CNAME app.customer.example -> d111111abcdef8.cloudfront.net  (site access)",
    )
    expect(output).toContain(
      "Once validation completes, re-deploy to enable the custom domain alias.",
    )
  })

  it("prints the default domain when no custom domain is configured", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-custom-domain-"))
    tempPaths.push(testDir)

    process.env["PFCLI_CREDENTIALS_PATH"] = createCredentialsFile(
      testDir,
      "http://mocked.test",
    )

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: {
            getDnsRecords: {
              defaultDomain: "prod.0000-0000-0002.app.processfocus.com",
              frontendUrl: "https://prod.0000-0000-0002.app.processfocus.com",
              frontendUrlNote: null,
              customDomain: null,
              certificateStatus: null,
              warnings: [],
              validationRecords: [],
              validationNote: null,
              siteAccessRecord: null,
              siteAccessNote: null,
              postscriptNotes: [],
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch

    const runCustomDomain = await loadRunCustomDomain()
    const { output } = await captureStdout(() =>
      Effect.runPromise(runCustomDomain("0000-0000-0002", "prod")),
    )

    expect(output).toContain(
      "No custom domain configured for 0000-0000-0002/prod.",
    )
    expect(output).toContain(
      "Frontend URL: https://prod.0000-0000-0002.app.processfocus.com",
    )
  })

  it("prints fallback notes when a custom domain has no certificate details yet", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-custom-domain-"))
    tempPaths.push(testDir)

    process.env["PFCLI_CREDENTIALS_PATH"] = createCredentialsFile(
      testDir,
      "http://mocked.test",
    )

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: {
            getDnsRecords: {
              defaultDomain: "prod.0000-0000-0002.app.processfocus.com",
              frontendUrl: "https://prod.0000-0000-0002.app.processfocus.com",
              frontendUrlNote:
                "custom domain is not live yet; keep using the default app domain until you have successfully redeployed the project.",
              customDomain: "app.customer.example",
              certificateStatus: null,
              warnings: [],
              validationRecords: [],
              validationNote:
                "No ACM certificate details found. Expected SSM parameter /pf-0000-0000-0002/env/prod/custom-domain-cert-arn",
              siteAccessRecord: null,
              siteAccessNote:
                "CloudFront distribution not deployed yet: site access record unavailable",
              postscriptNotes: [],
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch

    const runCustomDomain = await loadRunCustomDomain()
    const { output } = await captureStdout(() =>
      Effect.runPromise(runCustomDomain("0000-0000-0002", "prod")),
    )

    expect(output).toContain("Custom domain: app.customer.example")
    expect(output).toContain(
      "Frontend URL: https://prod.0000-0000-0002.app.processfocus.com",
    )
    expect(output).toContain(
      "Note: custom domain is not live yet; keep using the default app domain until you have successfully redeployed the project.",
    )
    expect(output).toContain(
      "(No ACM certificate details found. Expected SSM parameter /pf-0000-0000-0002/env/prod/custom-domain-cert-arn)",
    )
    expect(output).toContain(
      "(CloudFront distribution not deployed yet: site access record unavailable)",
    )
    expect(output).not.toContain("Status:")
    expect(output).not.toContain("Once validation completes")
  })

  it("prints the default alias until an issued certificate has been deployed", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-custom-domain-"))
    tempPaths.push(testDir)

    process.env["PFCLI_CREDENTIALS_PATH"] = createCredentialsFile(
      testDir,
      "http://mocked.test",
    )

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: {
            getDnsRecords: {
              defaultDomain: "prod.0000-0000-0002.app.processfocus.com",
              frontendUrl: "https://prod.0000-0000-0002.app.processfocus.com",
              frontendUrlNote:
                "custom domain is not live yet; keep using the default app domain until you have successfully redeployed the project.",
              customDomain: "app.customer.example",
              certificateStatus: "ISSUED",
              warnings: [],
              validationRecords: [],
              validationNote: null,
              siteAccessRecord: {
                type: "CNAME",
                name: "app.customer.example",
                value: "d111111abcdef8.cloudfront.net",
                purpose: "site access",
              },
              siteAccessNote: null,
              postscriptNotes: [],
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch

    const runCustomDomain = await loadRunCustomDomain()
    const { output } = await captureStdout(() =>
      Effect.runPromise(runCustomDomain("0000-0000-0002", "prod")),
    )

    expect(output).toContain("Custom domain: app.customer.example")
    expect(output).toContain("Status: ISSUED")
    expect(output).toContain(
      "Frontend URL: https://prod.0000-0000-0002.app.processfocus.com",
    )
    expect(output).toContain(
      "Note: custom domain is not live yet; keep using the default app domain until you have successfully redeployed the project.",
    )
  })

  it("prints the active custom-domain URL once the alias is live", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-custom-domain-"))
    tempPaths.push(testDir)

    process.env["PFCLI_CREDENTIALS_PATH"] = createCredentialsFile(
      testDir,
      "http://mocked.test",
    )

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: {
            getDnsRecords: {
              defaultDomain: "prod.0000-0000-0002.app.processfocus.com",
              frontendUrl: "https://app.customer.example",
              frontendUrlNote: null,
              customDomain: "app.customer.example",
              certificateStatus: "ISSUED",
              warnings: [],
              validationRecords: [],
              validationNote: null,
              siteAccessRecord: {
                type: "CNAME",
                name: "app.customer.example",
                value: "d111111abcdef8.cloudfront.net",
                purpose: "site access",
              },
              siteAccessNote: null,
              postscriptNotes: [],
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch

    const runCustomDomain = await loadRunCustomDomain()
    const { output } = await captureStdout(() =>
      Effect.runPromise(runCustomDomain("0000-0000-0002", "prod")),
    )

    expect(output).toContain("Custom domain: app.customer.example")
    expect(output).toContain("Status: ISSUED")
    expect(output).toContain("Frontend URL: https://app.customer.example")
    expect(output).not.toContain("Note:")
  })

  it("surfaces GraphQL errors as a custom-domain command failure", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-custom-domain-"))
    tempPaths.push(testDir)

    process.env["PFCLI_CREDENTIALS_PATH"] = createCredentialsFile(
      testDir,
      "http://mocked.test",
    )

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          errors: [{ message: "Resolver exploded" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch

    const runCustomDomain = await loadRunCustomDomain()
    const error: unknown = await Effect.runPromise(
      runCustomDomain("0000-0000-0002", "prod").pipe(Effect.flip),
    )

    expect(isCustomDomainError(error)).toBe(true)
    if (isCustomDomainError(error)) {
      expect(error._tag).toBe("CustomDomainError")
      expect(error.message).toBe("GraphQL error: Resolver exploded")
    }
  })

  it("surfaces GraphQL network failures as a custom-domain command failure", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "pfcli-custom-domain-"))
    tempPaths.push(testDir)

    process.env["PFCLI_CREDENTIALS_PATH"] = createCredentialsFile(
      testDir,
      "http://mocked.test",
    )

    globalThis.fetch = (async () => {
      throw new Error("connection refused")
    }) as unknown as typeof fetch

    const runCustomDomain = await loadRunCustomDomain()
    const error: unknown = await Effect.runPromise(
      runCustomDomain("0000-0000-0002", "prod").pipe(Effect.flip),
    )

    expect(isCustomDomainError(error)).toBe(true)
    if (isCustomDomainError(error)) {
      expect(error._tag).toBe("CustomDomainError")
      expect(error.message).toBe("Failed to call GraphQL endpoint")
    }
  })

  it("rejects the removed --region flag", async () => {
    const result = await runPfcliInProcess([
      "custom-domain",
      "--project",
      "0000-0000-0002",
      "--env",
      "prod",
      "--region",
      "ap-southeast-2",
    ])

    expect(result.status).not.toBe(0)
    expect(result.output).toContain("Received unknown argument: '--region'")
  })
})
