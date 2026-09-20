import { describe, expect, test } from "vitest"
import { mock } from "bun:test"

mock.module("server-only", () => ({}))

const { getCookieNamesFromHost } = await import("../lib/auth/session")

describe("getCookieNamesFromHost", () => {
  test("returns unsuffixed cookie names when host is empty", () => {
    expect(getCookieNamesFromHost("")).toEqual({
      accessToken: "access_token",
      refreshToken: "refresh_token",
      oauthState: "oauth_state",
      passkeyAuthCookies: "passkey_auth_cookies",
      registrationSession: "registration_session",
    })
  })

  test("returns unsuffixed cookie names for localhost without a port", () => {
    expect(getCookieNamesFromHost("localhost")).toEqual({
      accessToken: "access_token",
      refreshToken: "refresh_token",
      oauthState: "oauth_state",
      passkeyAuthCookies: "passkey_auth_cookies",
      registrationSession: "registration_session",
    })
  })

  test("returns unsuffixed cookie names for 127.0.0.1 without a port", () => {
    expect(getCookieNamesFromHost("127.0.0.1")).toEqual({
      accessToken: "access_token",
      refreshToken: "refresh_token",
      oauthState: "oauth_state",
      passkeyAuthCookies: "passkey_auth_cookies",
      registrationSession: "registration_session",
    })
  })

  test("returns port-suffixed cookie names on localhost", () => {
    expect(getCookieNamesFromHost("localhost:3000")).toEqual({
      accessToken: "access_token_3000",
      refreshToken: "refresh_token_3000",
      oauthState: "oauth_state_3000",
      passkeyAuthCookies: "passkey_auth_cookies_3000",
      registrationSession: "registration_session_3000",
    })
  })

  test("returns port-suffixed cookie names on 127.0.0.1", () => {
    expect(getCookieNamesFromHost("127.0.0.1:3000")).toEqual({
      accessToken: "access_token_3000",
      refreshToken: "refresh_token_3000",
      oauthState: "oauth_state_3000",
      passkeyAuthCookies: "passkey_auth_cookies_3000",
      registrationSession: "registration_session_3000",
    })
  })

  test("falls back to unsuffixed cookie names for invalid hosts", () => {
    expect(getCookieNamesFromHost("invalid host!!!")).toEqual({
      accessToken: "access_token",
      refreshToken: "refresh_token",
      oauthState: "oauth_state",
      passkeyAuthCookies: "passkey_auth_cookies",
      registrationSession: "registration_session",
    })
  })

  test("returns unsuffixed cookie names for production hostnames", () => {
    expect(getCookieNamesFromHost("app.example.com")).toEqual({
      accessToken: "access_token",
      refreshToken: "refresh_token",
      oauthState: "oauth_state",
      passkeyAuthCookies: "passkey_auth_cookies",
      registrationSession: "registration_session",
    })
  })
})
