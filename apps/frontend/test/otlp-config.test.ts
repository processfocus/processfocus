import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm"
import { afterEach, expect, test, vi } from "vitest"
import { resolveOtlpConfig } from "../lib/telemetry/otlp-config"
import { registerOtel } from "../lib/telemetry/register-otel"

const originalEnv = new Map<string, string | undefined>()
function setEnv(key: string, value: string): void {
  if (!originalEnv.has(key)) originalEnv.set(key, process.env[key])
  process.env[key] = value
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  originalEnv.clear()
})

test("frontend startup reads the current endpoint and matching credential, ignoring direct overrides", async () => {
  setEnv("AWS_LAMBDA_FUNCTION_NAME", "frontend")
  setEnv("OTLP_ENDPOINT_SSM_PARAMETER", "/otel/endpoint")
  setEnv("GRAFANA_TOKEN_SSM_PARAMETER", "/otel/grafana-token")
  setEnv("OTLP_ENDPOINT", "https://ignored.example")
  setEnv("GRAFANA_TOKEN", "ignored")
  let base = "https://receiver.example/first"
  const send = vi
    .spyOn(SSMClient.prototype, "send")
    .mockImplementation(async (command) => {
      if (!(command instanceof GetParameterCommand))
        throw new Error("Unexpected SSM command")
      return {
        Parameter: {
          Value: command.input.Name === "/otel/endpoint" ? base : "credential",
        },
      }
    })
  const first = await resolveOtlpConfig()
  base = "https://receiver.example/second"
  const second = await resolveOtlpConfig()
  expect(first?.tracesUrl).toBe("https://receiver.example/first/v1/traces")
  expect(second?.tracesUrl).toBe("https://receiver.example/second/v1/traces")
  expect(second?.headers).toEqual({ Authorization: "Basic credential" })
  expect(send).toHaveBeenCalledTimes(4)
})

test("unreadable endpoint leaves frontend available and registration is retained until a fresh startup", async () => {
  setEnv("AWS_LAMBDA_FUNCTION_NAME", "frontend")
  setEnv("OTLP_ENDPOINT_SSM_PARAMETER", "/otel/endpoint")
  setEnv("GRAFANA_TOKEN_SSM_PARAMETER", "/otel/grafana-token")
  setEnv("OTLP_ENDPOINT", "https://ignored.example")
  setEnv("GRAFANA_TOKEN", "ignored")
  const send = vi
    .spyOn(SSMClient.prototype, "send")
    .mockRejectedValue(new Error("secret"))
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
  const globals = globalThis as Record<string, unknown>
  const key = "__pf_otel_registered__"
  const original = globals[key]
  delete globals[key]
  try {
    await Promise.all([registerOtel(), registerOtel()])
    await registerOtel()
    expect(send).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Export disabled"),
    )
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret")
    delete globals[key]
    await registerOtel()
    expect(send).toHaveBeenCalledTimes(4)
  } finally {
    if (original === undefined) delete globals[key]
    else globals[key] = original
  }
})
