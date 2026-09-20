import posthog from "posthog-js"
import type {
  FrontendClientPluginRegistration,
  OrganisationFrontendPluginHost,
} from "@pf/frontend-plugin-host"
import {
  type LoadedPostHogClient,
  setLoadedPostHogClient,
} from "./posthog-client"
import { setPostHogReady } from "./posthog-ready-store"
import {
  frontendClientPlugin,
  organisationFrontendPlugin,
  resetFrontendClientPluginForTest,
  shouldActivatePostHogFrontendClientPlugin,
} from "./register-client"
import { afterEach, beforeEach, describe, expect, it } from "bun:test"

const forbiddenBrowserModule =
  /(?:^|\/)(?:apps\/frontend|job-worker|server-only)(?:\/|$)|(?:^|\/)(?:@aws-sdk|@effect|aws-cdk-lib|drizzle-orm|effect)(?:[+@/]|$)/

const createHost = (
  register: (plugin: FrontendClientPluginRegistration) => () => void,
): OrganisationFrontendPluginHost => ({
  kind: "organisation-plugin-host",
  interfaceVersion: 1,
  analytics: { register },
  formRenderers: { register: () => () => {} },
  executionMenu: { register: () => () => {} },
  graphql: { ClientConsumer: () => null },
})

describe("trusted PostHog browser entrypoint", () => {
  it("owns activation defaults and explicit overrides", () => {
    expect(shouldActivatePostHogFrontendClientPlugin({}, "development")).toBe(
      false,
    )
    expect(shouldActivatePostHogFrontendClientPlugin({}, "production")).toBe(
      true,
    )
    expect(
      shouldActivatePostHogFrontendClientPlugin(
        { enabled: true },
        "development",
      ),
    ).toBe(true)
    expect(
      shouldActivatePostHogFrontendClientPlugin(
        { enabled: false },
        "production",
      ),
    ).toBe(false)
  })

  it("registers identity, page rendering, and exception behavior without Dashboard", () => {
    let registration: FrontendClientPluginRegistration | undefined

    organisationFrontendPlugin.activate(
      createHost((plugin) => {
        registration = plugin
        return () => {}
      }),
    )

    expect(registration).toBe(frontendClientPlugin)
    expect(registration!.type).toBe("analytics.posthog")
    expect(registration!.render).toBeFunction()
    expect(registration!.renderIdentify).toBeFunction()
    expect(registration!.resetIdentity).toBeFunction()
    expect(registration!.captureClientException).toBeFunction()
    expect(registration!.captureGraphqlRequestError).toBeFunction()
  })

  it("bundles for browsers without server-heavy modules", async () => {
    const result = await Bun.build({
      entrypoints: [`${import.meta.dir}/register-client.tsx`],
      target: "browser",
      metafile: true,
    })

    expect(result.success).toBe(true)
    if (!result.metafile) {
      throw new Error("Expected browser bundle metadata")
    }
    const inputs = Object.keys(result.metafile.inputs)
    expect(
      inputs.some((input) => input.endsWith("/posthog-pageview-tracker.tsx")),
    ).toBe(true)
    expect(
      inputs.some((input) => input.endsWith("/posthog-browser-errors.tsx")),
    ).toBe(true)
    expect(
      inputs.filter((input) => forbiddenBrowserModule.test(input)),
    ).toEqual([])
  })

  it("keeps the activation policy independent from the PostHog client", async () => {
    const result = await Bun.build({
      entrypoints: [`${import.meta.dir}/activation-policy.ts`],
      target: "browser",
      metafile: true,
    })

    expect(result.success).toBe(true)
    if (!result.metafile) {
      throw new Error("Expected browser bundle metadata")
    }
    const inputs = Object.keys(result.metafile.inputs)
    expect(inputs.some((input) => input.includes("posthog-js"))).toBe(false)
    expect(inputs.some((input) => input.endsWith("/register-client.tsx"))).toBe(
      false,
    )
  })
})

describe("frontendClientPlugin.captureGraphqlRequestError", () => {
  let captureExceptionCalls: Array<{
    readonly error: unknown
    readonly properties: unknown
  }>
  let client: LoadedPostHogClient & {
    captureException: (error: unknown, properties?: unknown) => void
  }
  let originalCaptureException: typeof posthog.captureException
  let originalLoaded: boolean | undefined
  let originalPersistence: unknown
  let originalRequestQueue: unknown
  let originalSessionPersistence: unknown

  beforeEach(() => {
    captureExceptionCalls = []
    client = posthog as LoadedPostHogClient & {
      captureException: (error: unknown, properties?: unknown) => void
    }
    originalCaptureException = client.captureException
    originalLoaded = client.__loaded
    originalPersistence = client.persistence
    originalRequestQueue = client._requestQueue
    originalSessionPersistence = client.sessionPersistence
    client.captureException = (error: unknown, properties?: unknown) => {
      captureExceptionCalls.push({ error, properties })
    }
    ;(client as unknown as { persistence: unknown }).persistence = {}
    ;(client as unknown as { _requestQueue: unknown })._requestQueue = {}
    ;(client as unknown as { sessionPersistence: unknown }).sessionPersistence =
      {}
    resetFrontendClientPluginForTest()
    setLoadedPostHogClient(null)
    setPostHogReady(false)
  })

  afterEach(() => {
    ;(
      client as unknown as {
        captureException: typeof posthog.captureException
      }
    ).captureException = originalCaptureException

    if (originalLoaded === undefined) {
      Reflect.deleteProperty(client, "__loaded")
    } else {
      client.__loaded = originalLoaded
    }

    ;(client as unknown as { persistence: unknown }).persistence =
      originalPersistence
    ;(client as unknown as { _requestQueue: unknown })._requestQueue =
      originalRequestQueue
    ;(client as unknown as { sessionPersistence: unknown }).sessionPersistence =
      originalSessionPersistence

    resetFrontendClientPluginForTest()
    setLoadedPostHogClient(null)
    setPostHogReady(false)
  })

  it("captures GraphQL request errors immediately when PostHog is loaded", () => {
    client.__loaded = true
    setLoadedPostHogClient(client)

    const error = new Error("GraphQL request failed for FormMetadata")

    frontendClientPlugin.captureGraphqlRequestError({}, error, {
      graphqlErrors: [
        {
          code: "INTERNAL_SERVER_ERROR",
          message: "temporary failure",
          path: "formMetadata",
        },
      ],
      operationName: "FormMetadata",
      pathname: "/processes/start/enrolment-enquiry/Submit enquiry",
      responseStatus: 200,
    })

    expect(captureExceptionCalls).toEqual([
      {
        error,
        properties: {
          graphql_error_codes: ["INTERNAL_SERVER_ERROR"],
          graphql_error_count: 1,
          graphql_error_messages: ["temporary failure"],
          graphql_error_paths: ["formMetadata"],
          graphql_operation_name: "FormMetadata",
          graphql_pathname: "/processes/start/enrolment-enquiry/Submit enquiry",
          graphql_response_status: 200,
        },
      },
    ])
  })

  it("queues GraphQL request errors until PostHog becomes ready", () => {
    client.__loaded = false

    const error = new Error("GraphQL request failed for FormMetadata")

    frontendClientPlugin.captureGraphqlRequestError({}, error, {
      graphqlErrors: [],
      operationName: "FormMetadata",
      pathname: "/processes/start/enrolment-enquiry/Submit enquiry",
      responseStatus: 500,
    })

    expect(captureExceptionCalls).toEqual([])

    client.__loaded = true
    setLoadedPostHogClient(client)
    setPostHogReady(true)

    expect(captureExceptionCalls).toEqual([
      {
        error,
        properties: {
          graphql_error_codes: [],
          graphql_error_count: 0,
          graphql_error_messages: [],
          graphql_error_paths: [],
          graphql_operation_name: "FormMetadata",
          graphql_pathname: "/processes/start/enrolment-enquiry/Submit enquiry",
          graphql_response_status: 500,
        },
      },
    ])
  })

  it("captures handled client exceptions with embed properties", () => {
    client.__loaded = true
    setLoadedPostHogClient(client)

    const error = new Error("Embedded form submit failed: temporary failure")

    frontendClientPlugin.captureClientException({}, error, {
      embed_process_path: "/enrolment-enquiry",
      embed_response_status: 400,
      embed_step_path: "/enrolment-enquiry/Submit enquiry",
    })

    expect(captureExceptionCalls).toEqual([
      {
        error,
        properties: {
          embed_process_path: "/enrolment-enquiry",
          embed_response_status: 400,
          embed_step_path: "/enrolment-enquiry/Submit enquiry",
        },
      },
    ])
  })
})
