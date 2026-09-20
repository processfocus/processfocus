import { extractHiddenCiProviderUserArgs } from "../src/utils/hidden-ci-provider-user-args"
import { describe, expect, it } from "bun:test"

describe("hidden CI provider-user args", () => {
  it("strips the separated value form from auth login", () => {
    expect(
      extractHiddenCiProviderUserArgs([
        "bun",
        "main.ts",
        "auth",
        "login",
        "--ci-provider-user",
        "admin@example.com",
      ]),
    ).toEqual({
      argv: ["bun", "main.ts", "auth", "login"],
      providerUser: "admin@example.com",
    })
  })

  it("strips the equals value form from auth login", () => {
    expect(
      extractHiddenCiProviderUserArgs([
        "bun",
        "main.ts",
        "auth",
        "login",
        "--ci-provider-user=admin@example.com",
      ]),
    ).toEqual({
      argv: ["bun", "main.ts", "auth", "login"],
      providerUser: "admin@example.com",
    })
  })

  it("strips the hidden flag before the subcommand", () => {
    expect(
      extractHiddenCiProviderUserArgs([
        "bun",
        "main.ts",
        "--ci-provider-user=admin@example.com",
        "auth",
        "login",
      ]),
    ).toEqual({
      argv: ["bun", "main.ts", "auth", "login"],
      providerUser: "admin@example.com",
    })
  })

  it("keeps empty equals values for login validation", () => {
    expect(
      extractHiddenCiProviderUserArgs([
        "bun",
        "main.ts",
        "auth",
        "login",
        "--ci-provider-user=",
      ]),
    ).toEqual({
      argv: ["bun", "main.ts", "auth", "login"],
      providerUser: "",
    })
  })

  it("rejects the hidden flag outside auth login", () => {
    expect(
      extractHiddenCiProviderUserArgs([
        "bun",
        "main.ts",
        "deploy",
        "examples/school",
        "--ci-provider-user=admin@example.com",
      ]),
    ).toEqual({
      argv: ["bun", "main.ts", "deploy", "examples/school"],
      error: "--ci-provider-user is only supported by auth login",
    })
  })

  it("rejects missing and duplicate values", () => {
    expect(
      extractHiddenCiProviderUserArgs([
        "bun",
        "main.ts",
        "auth",
        "login",
        "--ci-provider-user",
      ]),
    ).toEqual({
      argv: ["bun", "main.ts", "auth", "login"],
      error: "--ci-provider-user requires an email address",
    })

    expect(
      extractHiddenCiProviderUserArgs([
        "bun",
        "main.ts",
        "auth",
        "login",
        "--ci-provider-user=first@example.com",
        "--ci-provider-user=second@example.com",
      ]),
    ).toEqual({
      argv: ["bun", "main.ts", "auth", "login"],
      error: "--ci-provider-user must only be provided once",
    })
  })
})
