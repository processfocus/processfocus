import {
  normalizeNextDynamicRouteParameterTokens,
  normalizeNextMetadata,
} from "./deterministic-next-artifacts"
import { describe, expect, it } from "bun:test"

describe("normalizeNextDynamicRouteParameterTokens", () => {
  it("makes opaque Next fallback-route sentinels repeatable", () => {
    const firstBuild =
      "before %%drp:token:61cbb9ea2f9e6%% and %%drp:path:54c3817b25fa9%% after"
    const secondBuild =
      "before %%drp:token:8d65dfcb96de6%% and %%drp:path:82ac4654c17df%% after"

    expect(
      normalizeNextDynamicRouteParameterTokens(firstBuild, "candidate-1"),
    ).toBe(normalizeNextDynamicRouteParameterTokens(secondBuild, "candidate-1"))
    expect(
      normalizeNextDynamicRouteParameterTokens(firstBuild, "candidate-1"),
    ).not.toBe(
      normalizeNextDynamicRouteParameterTokens(firstBuild, "candidate-2"),
    )
  })

  it("leaves unrelated output untouched", () => {
    const content = "%%drp:token:not-hex%% ordinary dashboard output"

    expect(
      normalizeNextDynamicRouteParameterTokens(content, "candidate-1"),
    ).toBe(content)
  })
})

describe("normalizeNextMetadata", () => {
  it("recalculates Next's nested postponed-state lengths", () => {
    const firstReplacements = '[["token",["%%drp:token:123456789abcd%%","d"]]]'
    const secondReplacements =
      '[["token",["%%drp:token:123456789abcde%%","d"]]]'
    const firstData = '[1,{"route":"%%drp:token:123456789abcd%%"}]'
    const secondData = '[1,{"route":"%%drp:token:123456789abcde%%"}]'
    const firstPostponed = `${firstReplacements.length}${firstReplacements}${firstData}`
    const secondPostponed = `${secondReplacements.length}${secondReplacements}${secondData}`
    const firstMetadata = JSON.stringify({
      postponed: `${firstPostponed.length}:${firstPostponed}cache`,
    })
    const secondMetadata = JSON.stringify({
      postponed: `${secondPostponed.length}:${secondPostponed}cache`,
    })

    const normalizedFirst = normalizeNextMetadata(firstMetadata, "candidate-1")
    const normalizedSecond = normalizeNextMetadata(
      secondMetadata,
      "candidate-1",
    )

    expect(normalizedFirst).toBe(normalizedSecond)
    const parsed: unknown = JSON.parse(normalizedFirst)
    expect(parsed).toEqual({
      postponed:
        '92:47[["token",["%%drp:token:a59e3a86d6c39%%","d"]]][1,{"route":"%%drp:token:a59e3a86d6c39%%"}]cache',
    })
  })
})
