import type { DocumentNode } from "graphql"
import { ClientError } from "graphql-request"
import {
  buildGraphqlRequestErrorDetails,
  buildGraphqlRequestException,
  reportGraphqlRequestError,
} from "../lib/graphql/client-error-reporting"
import { afterEach, describe, expect, test } from "bun:test"

const originalWindow = globalThis.window

describe("client GraphQL error reporting", () => {
  afterEach(() => {
    if (originalWindow === undefined) {
      Reflect.deleteProperty(globalThis, "window")
      return
    }

    globalThis.window = originalWindow
  })

  test("extracts structured details from GraphQL client errors", () => {
    globalThis.window = {
      location: {
        pathname: "/processes/start/enrolment-enquiry/Submit%20enquiry",
      },
    } as Window & typeof globalThis

    const error = new ClientError(
      {
        errors: [
          {
            extensions: { code: "NotAuthorized" },
            message: "You do not have permission to access this form.",
            path: ["formMetadata"],
          },
        ],
        status: 200,
      },
      {
        query: `query FormMetadata($stepPath: String!) { formMetadata(stepPath: $stepPath) { stepPath } }`,
        variables: {
          email: "secret@example.com",
          stepPath: "/enrolment-enquiry/Submit enquiry",
        },
      },
    )

    const details = buildGraphqlRequestErrorDetails(
      `query FormMetadata($stepPath: String!) { formMetadata(stepPath: $stepPath) { stepPath } }`,
      error,
    )

    expect(details).toEqual({
      graphqlErrors: [
        {
          code: "NotAuthorized",
          message: "You do not have permission to access this form.",
          path: "formMetadata",
        },
      ],
      operationName: "FormMetadata",
      pathname: "/processes/start/enrolment-enquiry/Submit%20enquiry",
      responseStatus: 200,
    })
  })

  test("builds a sanitized exception without request variables", () => {
    const details = {
      graphqlErrors: [
        {
          code: "NotAuthorized",
          message: "You do not have permission to access this form.",
          path: "formMetadata",
        },
      ],
      operationName: "FormMetadata",
      pathname: "/processes/start/enrolment-enquiry/Submit%20enquiry",
      responseStatus: 200,
    } as const

    const exception = buildGraphqlRequestException(details, new Error("unused"))

    expect(exception.message).toBe(
      "GraphQL request failed for FormMetadata: You do not have permission to access this form.",
    )
    expect(exception.message).not.toContain("secret@example.com")
    expect(exception.message).not.toContain("stepPath")
  })

  test("extracts operation names from generated GraphQL documents without loc", () => {
    const details = buildGraphqlRequestErrorDetails(
      {
        definitions: [
          {
            kind: "OperationDefinition",
            name: { kind: "Name", value: "ProcessStateForExecution" },
            operation: "query",
          },
        ],
        kind: "Document",
      } as DocumentNode,
      new ClientError(
        {
          errors: [{ message: "Unauthenticated" }],
          status: 401,
        },
        { query: "" },
      ),
    )

    expect(details.operationName).toBe("ProcessStateForExecution")
    expect(buildGraphqlRequestException(details, new Error()).message).toBe(
      "GraphQL request failed for ProcessStateForExecution with HTTP 401: Unauthenticated",
    )
  })

  test("reports sanitized GraphQL request failures to active plugins", () => {
    const calls: Array<{ details: unknown; error: Error }> = []

    reportGraphqlRequestError(
      [
        {
          config: { enabled: true },
          registration: {
            captureGraphqlRequestError(_config, error, details) {
              calls.push({ details, error })
            },
            render() {
              return null
            },
            type: "analytics.posthog",
          },
        },
      ],
      `mutation StartProcess { startProcess { executionId } }`,
      new ClientError(
        {
          errors: [
            {
              extensions: { code: "UnexpectedError" },
              message: "Database unavailable",
              path: ["startProcess"],
            },
          ],
          status: 500,
        },
        {
          query: `mutation StartProcess { startProcess { executionId } }`,
          variables: { childName: "Private Student" },
        },
      ),
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]?.error.message).toBe(
      "GraphQL request failed for StartProcess with HTTP 500: Database unavailable",
    )
    expect(calls[0]?.error.message).not.toContain("Private Student")
    expect(calls[0]?.details).toEqual({
      graphqlErrors: [
        {
          code: "UnexpectedError",
          message: "Database unavailable",
          path: "startProcess",
        },
      ],
      operationName: "StartProcess",
      pathname: null,
      responseStatus: 500,
    })
  })

  test("does not report expected current provider user auth expiry", () => {
    const calls: Array<{ details: unknown; error: Error }> = []

    reportGraphqlRequestError(
      [
        {
          config: { enabled: true },
          registration: {
            captureGraphqlRequestError(_config, error, details) {
              calls.push({ details, error })
            },
            render() {
              return null
            },
            type: "analytics.posthog",
          },
        },
      ],
      `query CurrentProviderUser { currentProviderUser { id } }`,
      new ClientError(
        {
          errors: [{ message: "Unauthenticated" }],
          status: 401,
        },
        { query: `query CurrentProviderUser { currentProviderUser { id } }` },
      ),
    )

    expect(calls).toHaveLength(0)
  })

  test("reports unexpected current provider user server failures", () => {
    const calls: Array<{ details: unknown; error: Error }> = []

    reportGraphqlRequestError(
      [
        {
          config: { enabled: true },
          registration: {
            captureGraphqlRequestError(_config, error, details) {
              calls.push({ details, error })
            },
            render() {
              return null
            },
            type: "analytics.posthog",
          },
        },
      ],
      `query CurrentProviderUser { currentProviderUser { id } }`,
      new ClientError(
        {
          errors: [{ message: "Database unavailable" }],
          status: 500,
        },
        { query: `query CurrentProviderUser { currentProviderUser { id } }` },
      ),
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]?.error.message).toBe(
      "GraphQL request failed for CurrentProviderUser with HTTP 500: Database unavailable",
    )
  })

  test("does not report paired current provider user fetch failures", () => {
    const calls: Array<{ details: unknown; error: Error }> = []

    reportGraphqlRequestError(
      [
        {
          config: { enabled: true },
          registration: {
            captureGraphqlRequestError(_config, error, details) {
              calls.push({ details, error })
            },
            render() {
              return null
            },
            type: "analytics.posthog",
          },
        },
      ],
      `query CurrentProviderUser { currentProviderUser { id } }`,
      new Error("Failed to fetch"),
    )

    expect(calls).toHaveLength(0)
  })

  test("does not report sanitized current provider user auth failures", () => {
    const calls: Array<{ details: unknown; error: Error }> = []

    reportGraphqlRequestError(
      [
        {
          config: { enabled: true },
          registration: {
            captureGraphqlRequestError(_config, error, details) {
              calls.push({ details, error })
            },
            render() {
              return null
            },
            type: "analytics.posthog",
          },
        },
      ],
      null,
      new Error(
        "GraphQL request failed for CurrentProviderUser with HTTP 401: Unauthenticated",
      ),
    )

    expect(calls).toHaveLength(0)
  })

  test("reports sanitized auth failures for other operations", () => {
    const calls: Array<{ details: unknown; error: Error }> = []

    reportGraphqlRequestError(
      [
        {
          config: { enabled: true },
          registration: {
            captureGraphqlRequestError(_config, error, details) {
              calls.push({ details, error })
            },
            render() {
              return null
            },
            type: "analytics.posthog",
          },
        },
      ],
      null,
      new Error(
        "GraphQL request failed for ProcessStateForExecution with HTTP 401: Unauthenticated",
      ),
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]?.error.message).toBe(
      "GraphQL request failed for ProcessStateForExecution with HTTP 401: Unauthenticated",
    )
  })

  test("reports current provider user messages with non-401 HTTP statuses", () => {
    const calls: Array<{ details: unknown; error: Error }> = []

    reportGraphqlRequestError(
      [
        {
          config: { enabled: true },
          registration: {
            captureGraphqlRequestError(_config, error, details) {
              calls.push({ details, error })
            },
            render() {
              return null
            },
            type: "analytics.posthog",
          },
        },
      ],
      null,
      new Error(
        "GraphQL request failed for CurrentProviderUser with HTTP 4010: Unexpected status",
      ),
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]?.error.message).toBe(
      "GraphQL request failed for CurrentProviderUser with HTTP 4010: Unexpected status",
    )
  })

  test("does not report sanitized current provider user browser network failures", () => {
    const calls: Array<{ details: unknown; error: Error }> = []

    reportGraphqlRequestError(
      [
        {
          config: { enabled: true },
          registration: {
            captureGraphqlRequestError(_config, error, details) {
              calls.push({ details, error })
            },
            render() {
              return null
            },
            type: "analytics.posthog",
          },
        },
      ],
      null,
      new Error(
        "GraphQL request failed for CurrentProviderUser: NetworkError when attempting to fetch resource.",
      ),
    )

    expect(calls).toHaveLength(0)
  })

  test("does not report current provider user browser network failures", () => {
    const calls: Array<{ details: unknown; error: Error }> = []

    reportGraphqlRequestError(
      [
        {
          config: { enabled: true },
          registration: {
            captureGraphqlRequestError(_config, error, details) {
              calls.push({ details, error })
            },
            render() {
              return null
            },
            type: "analytics.posthog",
          },
        },
      ],
      `query CurrentProviderUser { currentProviderUser { id } }`,
      new Error("NetworkError when attempting to fetch resource."),
    )

    expect(calls).toHaveLength(0)
  })
})
