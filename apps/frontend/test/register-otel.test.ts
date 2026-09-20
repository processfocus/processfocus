import { describe, expect, test, vi } from "vitest"
import {
  readPfScopeFromEnv,
  registerOtel,
} from "../lib/telemetry/register-otel"

describe("readPfScopeFromEnv", () => {
  test("keeps an explicit PF_SCOPE override when present", () => {
    expect(
      readPfScopeFromEnv({
        PF_PROJECT: "0000-1000-1000",
        PF_ENV: "bdb",
        PF_SCOPE: "pf-console-bdb",
      }),
    ).toEqual({
      pfProject: "0000-1000-1000",
      pfEnv: "bdb",
      pfScope: "pf-console-bdb",
    })
  })

  test("derives pfScope from project and env when PF_SCOPE is missing", () => {
    expect(
      readPfScopeFromEnv({
        PF_PROJECT: "0000-1000-1000",
        PF_ENV: "bdb",
      }),
    ).toEqual({
      pfProject: "0000-1000-1000",
      pfEnv: "bdb",
      pfScope: "pf-0000-1000-1000-bdb",
    })
  })

  test("falls back to unknown values when PF scope env vars are absent", () => {
    expect(readPfScopeFromEnv({})).toEqual({
      pfProject: "unknown",
      pfEnv: "unknown",
      pfScope: "pf-unknown-unknown",
    })
  })
})

describe("registerOtel", () => {
  test("disables Lambda export when no SSM telemetry source is configured", async () => {
    const originalLambdaName = process.env["AWS_LAMBDA_FUNCTION_NAME"]
    const originalToken = process.env["GRAFANA_TOKEN"]
    const originalParameter = process.env["GRAFANA_TOKEN_SSM_PARAMETER"]
    const globals = globalThis as Record<string, unknown>
    const registrationKey = "__pf_otel_registered__"
    const originalRegistration = globals[registrationKey]
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)

    process.env["AWS_LAMBDA_FUNCTION_NAME"] = "frontend"
    delete process.env["GRAFANA_TOKEN"]
    delete process.env["GRAFANA_TOKEN_SSM_PARAMETER"]
    delete globals[registrationKey]

    try {
      await registerOtel()

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          "missing endpoint or credential SSM parameter path",
        ),
      )
    } finally {
      warn.mockRestore()
      restoreEnvironment("AWS_LAMBDA_FUNCTION_NAME", originalLambdaName)
      restoreEnvironment("GRAFANA_TOKEN", originalToken)
      restoreEnvironment("GRAFANA_TOKEN_SSM_PARAMETER", originalParameter)
      if (originalRegistration === undefined) {
        delete globals[registrationKey]
      } else {
        globals[registrationKey] = originalRegistration
      }
    }
  })
})

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
}
