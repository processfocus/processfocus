import { describe, expect, test } from "vitest"
import { tokenizeCedar } from "../lib/cedar-highlight"

describe("tokenizeCedar", () => {
  test("highlights policy keywords, comments, strings, and entities", () => {
    const tokens = tokenizeCedar(`// starter
permit (
    principal is PF::ProviderUser,
    action == PF::Action::"complete",
    resource is PF::Step
)
when { principal.roles.contains(resource.role) };`)

    expect(tokens.some((token) => token.kind === "comment")).toBe(true)
    expect(
      tokens.some(
        (token) => token.kind === "keyword" && token.value === "permit",
      ),
    ).toBe(true)
    expect(
      tokens.some(
        (token) =>
          token.kind === "entity" && token.value === "PF::ProviderUser",
      ),
    ).toBe(true)
    expect(
      tokens.some(
        (token) => token.kind === "string" && token.value === '"complete"',
      ),
    ).toBe(true)
    expect(tokens.map((token) => token.value).join("")).toContain("permit")
  })

  test("highlights schema keywords", () => {
    const tokens = tokenizeCedar(`namespace PF {
    entity Role;
    action complete appliesTo {
        principal: ProviderUser,
        resource: Step,
    };
}`)
    expect(
      tokens
        .filter((token) => token.kind === "keyword")
        .map((token) => token.value),
    ).toEqual(
      expect.arrayContaining([
        "namespace",
        "entity",
        "action",
        "appliesTo",
        "principal",
        "resource",
      ]),
    )
  })
})
