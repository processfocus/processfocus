import { createHash } from "node:crypto"
import { Effect, Option, Result, Schema } from "effect"
import { ClientError, type GraphQLClient } from "graphql-request"
import {
  ListStartContext,
  ListUnavailable,
  resolveListStartContext,
} from "./lists"
import type { McpAccess } from "./oauth"
import { toolError } from "./read-tool"
import { toolData } from "./result"
import { graphql } from "@/lib/generated/gql"

const catalog = graphql(`
  query McpProcessCatalog($page: Int!, $processPath: String) {
    processes(page: $page, limit: 25, processPath: $processPath, requireStartMutation: true) {
      page
      hasNextPage
      nodes { path name category purpose }
    }
  }
`)

const startForm = graphql(`
  query McpProcessStartForm($processPath: String!, $input: JSON!) {
    processStartForm(processPath: $processPath, input: $input) {
      startStepPath
      mutationName
      inputTypeName
      fields
      defaultValues
      errors
      requiresDashboard
      unconfirmedDefaults
      submissionInput
    }
  }
`)

const processPath = { type: "string" }
const listContextProperty = {
  type: "object",
  description:
    "For a related Process, supply the List path from describe_list and, when working from a record, the exact selected record ID. Keep this context separate from authored form answers.",
  properties: {
    listPath: { type: "string" },
    recordId: { type: "string" },
    sourcePage: {
      type: "object",
      description:
        "Required with recordId when describe_list reports that inspect is not permitted. Copy sourcePage from the browse_list response containing the selected record. If the record is no longer on that page, browse again before continuing.",
      properties: {
        page: { type: "integer", minimum: 1, maximum: 2147483647 },
        filter: { type: "string" },
      },
      required: ["page"],
    },
  },
  required: ["listPath"],
}
const inputProperty = {
  type: "object",
  description:
    "Encoded answers as a JSON object. Build nested objects from field path segments. Omit unanswered fields; do not invent values.",
}
const executionIdPattern = "^pex-[A-Za-z0-9][A-Za-z0-9-]{0,36}$"
const executionId = {
  type: "string",
  pattern: executionIdPattern,
  description:
    "Generate and retain a fresh ID before sending (for example, pex- followed by a UUID). Reuse it only to recover this exact submission.",
}
const list = {
  name: "list_startable_processes",
  description:
    "List organisation-defined Processes the signed-in person may start. Start at page 1 and continue while hasNextPage is true.",
  inputSchema: {
    type: "object" as const,
    properties: {
      page: { type: "integer", minimum: 1, maximum: 2147483647, default: 1 },
    },
  },
  annotations: { readOnlyHint: true },
}
const inspect = {
  name: "get_process_start_form",
  description:
    "Inspect a selected Process's authored start form without starting it. For a related Process, use a permitted action from describe_list and keep listContext on every call. Use List or record information only to inform user-confirmed answers to authored fields; do not invent a field mapping. Recheck with current answers for conditional fields and validation. Ask about unanswered required fields; if requiresDashboard is true, give the user the Dashboard link instead.",
  inputSchema: {
    type: "object" as const,
    properties: {
      processPath,
      input: inputProperty,
      listContext: listContextProperty,
    },
    required: ["processPath"],
  },
  annotations: { readOnlyHint: true },
}
const start = {
  name: "start_process",
  description:
    "Submit an inspected Process start form only when the user explicitly chooses to start it and the target and answers are clear. Creating a List record does not start a Process. If both meanings are plausible, ask before writing and wait for the user's choice. For a related start keep the inspected listContext. Include displayed editable defaults the user accepted as explicit answers. Retain the exact executionId, processPath, input and listContext before sending; use those unchanged arguments to recover a lost response, never submit again to find out what happened.",
  inputSchema: {
    type: "object" as const,
    properties: {
      processPath,
      input: inputProperty,
      listContext: listContextProperty,
      executionId,
      confirmed: { type: "boolean", const: true },
    },
    required: ["processPath", "input", "executionId", "confirmed"],
  },
}
const recover = {
  name: "recover_process_start",
  description:
    "Recover the result of a lost Process start response using the same signed-in caller, executionId, processPath, input and listContext. This never starts another Execution. If unknown, do not submit again automatically.",
  inputSchema: {
    type: "object" as const,
    properties: {
      processPath,
      input: inputProperty,
      executionId,
      listContext: listContextProperty,
    },
    required: ["processPath", "input", "executionId"],
  },
  annotations: { readOnlyHint: true },
}
export const processTools = [list, inspect, start, recover]

const Answers = Schema.Record(Schema.String, Schema.Unknown)
const ProcessPath = Schema.NonEmptyString
const Context = Schema.optionalKey(ListStartContext)
const Submission = Schema.Struct({
  processPath: ProcessPath,
  input: Answers,
  listContext: Context,
  executionId: Schema.String.check(
    Schema.isPattern(new RegExp(executionIdPattern)),
  ),
})
const ConfirmedSubmission = Schema.Struct({
  ...Submission.fields,
  confirmed: Schema.Literal(true),
})
const FieldErrors = Schema.Array(
  Schema.Struct({ field: Schema.String, message: Schema.String }),
)
const GraphQLName = /^[_A-Za-z][_0-9A-Za-z]*$/
const normalizeProcessPath = (path: string): string =>
  path.startsWith("/") ? path : `/${path}`

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical)
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(Reflect.get(value, key))]),
  )
}

interface StartReceipt {
  readonly fingerprint: string
  readonly expiresAt: number
  started: boolean
}
// The receipts share the local MCP grant lifetime boundary: process-local,
// no answers or credentials stored, and never replay an uncertain mutation.
const receipts = new Map<string, StartReceipt>()
const receiptLifetime = 60 * 60 * 1000
const unavailable = () => toolError("The Process is not available to start.")
const unknownOutcome = () =>
  toolData({
    status: "unknown",
    message:
      "The original submission could not be confirmed. Do not submit again automatically.",
  })

const graphqlFailure = (cause: unknown) => {
  if (cause instanceof ClientError) {
    for (const error of cause.response.errors ?? []) {
      if (error.extensions?.["code"] === "InputValidationError") {
        const errors = Schema.decodeUnknownOption(FieldErrors)(
          error.extensions["errors"],
        )
        return toolData({
          status: "invalid",
          ...(Option.isSome(errors)
            ? { errors: errors.value }
            : { message: error.message }),
        })
      }
      if (error.extensions?.["code"] === "ExecutionIdConflictError")
        return toolError("Execution ID is already in use.")
      if (
        error.extensions?.["code"] === "NotAuthorized" ||
        error.extensions?.["code"] === "UNAUTHENTICATED"
      )
        return unavailable()
    }
  }
  return unknownOutcome()
}

interface ProcessToolCall {
  readonly client: GraphQLClient
  readonly access: McpAccess
  readonly origin: string
  readonly name: string
  readonly input: unknown
}

export const callProcessTool = ({
  client,
  access,
  origin,
  name,
  input,
}: ProcessToolCall) =>
  Effect.gen(function* () {
    if (name === list.name) {
      const args = Schema.decodeUnknownOption(
        Schema.Struct({
          page: Schema.optional(
            Schema.Int.check(
              Schema.isBetween({ minimum: 1, maximum: 2147483647 }),
            ),
          ),
        }),
      )(input)
      if (Option.isNone(args)) return toolError("Invalid Process page.")
      const { processes } = yield* Effect.tryPromise(() =>
        client.request(catalog, { page: args.value.page ?? 1 }),
      )
      return toolData(processes)
    }
    if (name !== inspect.name && name !== start.name && name !== recover.name)
      return toolError("Unknown tool.")
    if ((name === start.name || name === recover.name) && !access.canAct)
      return toolError("A View and act grant is required.")

    const started = (id: string) =>
      toolData({
        status: "started",
        executionId: id,
        executionUrl: new URL(`/executions/${encodeURIComponent(id)}`, origin)
          .href,
      })
    if (name === recover.name) {
      const args = Schema.decodeUnknownOption(Submission)(input)
      if (Option.isNone(args))
        return toolError(
          "Supply the original Process, Execution ID and answers.",
        )
      const { executionId, input: answers, listContext } = args.value
      const processPath = normalizeProcessPath(args.value.processPath)
      const { processes } = yield* Effect.tryPromise(() =>
        client.request(catalog, { page: 1, processPath }),
      )
      if (processes.nodes.length === 0) return unavailable()
      const receipt = receipts.get(JSON.stringify([origin, executionId]))
      return receipt?.started &&
        receipt.expiresAt > Date.now() &&
        receipt.fingerprint ===
          fingerprint(access, processPath, answers, listContext)
        ? started(executionId)
        : unknownOutcome()
    }

    const submission =
      name === start.name
        ? Schema.decodeUnknownOption(ConfirmedSubmission)(input)
        : Option.none()
    if (name === start.name && Option.isNone(submission))
      return toolError(
        "Supply the Process, answers, a fresh Execution ID and explicit confirmation.",
      )
    const inspection = Schema.decodeUnknownOption(
      Schema.Struct({
        processPath: ProcessPath,
        input: Schema.optional(Answers),
        listContext: Context,
      }),
    )(input)
    if (Option.isNone(inspection))
      return toolError("Supply a Process path and optional form answers.")
    const { input: answers = {}, listContext } = inspection.value
    const processPath = normalizeProcessPath(inspection.value.processPath)
    if (listContext && !access.canAct)
      return toolError(
        "A View and act grant is required for a related Process.",
      )
    const { processStartForm: form } = yield* Effect.tryPromise(() =>
      client.request(startForm, { processPath, input: answers }),
    )
    if (!form) return unavailable()
    const context = listContext
      ? yield* resolveListStartContext(
          client,
          listContext,
          processPath,
          form.startStepPath,
        )
      : undefined
    const dashboard = new URL(
      `/processes/start/${form.startStepPath.split("/").filter(Boolean).map(encodeURIComponent).join("/")}`,
      origin,
    )
    if (context) {
      dashboard.searchParams.set(
        "returnTo",
        `/lists/${context.listPath.split("/").filter(Boolean).map(encodeURIComponent).join("/")}`,
      )
      // The context lookup above verified the selected ID against this List.
      if (listContext?.recordId !== undefined)
        dashboard.searchParams.set("sourceRecordId", listContext.recordId)
    }
    const dashboardUrl = dashboard.href
    const formContext = context ? { listContext: context } : {}
    if (Option.isNone(submission))
      return toolData({
        processPath,
        ...formContext,
        fields: form.fields,
        defaultValues: form.defaultValues,
        errors: form.errors,
        requiresDashboard: form.requiresDashboard,
        unconfirmedDefaults: form.unconfirmedDefaults,
        dashboardUrl,
      })
    if (form.requiresDashboard)
      return toolData({
        status: "dashboard_required",
        ...formContext,
        dashboardUrl,
        message: "Nothing was submitted. Finish the form in the Dashboard.",
      })
    const errors = Schema.decodeUnknownOption(FieldErrors)(form.errors)
    if (Option.isNone(errors))
      return toolError("The runtime returned invalid Process form errors.")
    if (errors.value.length)
      return toolData({ status: "invalid", errors: errors.value })
    if (form.unconfirmedDefaults.length)
      return toolData({
        status: "confirmation_required",
        defaultValues: form.defaultValues,
        unconfirmedDefaults: form.unconfirmedDefaults,
        message:
          "Nothing was submitted. Show these defaults to the user and include the confirmed values in the answers.",
      })
    const { executionId } = submission.value
    if (
      !GraphQLName.test(form.mutationName) ||
      (form.inputTypeName && !GraphQLName.test(form.inputTypeName))
    )
      return unavailable()
    if (!form.inputTypeName && Object.keys(answers).length)
      return toolError("This Process does not accept start form answers.")

    const now = Date.now()
    for (const [key, receipt] of receipts)
      if (receipt.expiresAt <= now) receipts.delete(key)
    const key = JSON.stringify([origin, executionId])
    if (receipts.has(key))
      return toolError(
        "Execution ID is already in use. Recover only with the original submission.",
      )
    const receipt: StartReceipt = {
      fingerprint: fingerprint(access, processPath, answers, listContext),
      expiresAt: now + receiptLifetime,
      started: false,
    }
    receipts.set(key, receipt)
    const inputDeclaration = form.inputTypeName
      ? `, $input: ${form.inputTypeName}!`
      : ""
    const inputArgument = form.inputTypeName ? ", input: $input" : ""
    const result = yield* Effect.result(
      Effect.tryPromise(() =>
        client.request<{
          start: { executionId: string; deduplicated: boolean }
        }>(
          `mutation McpStartProcess($id: ID!${inputDeclaration}) {
          start: ${form.mutationName}(executionId: $id${inputArgument}) {
            executionId deduplicated
          }
        }`,
          {
            id: executionId,
            ...(form.inputTypeName ? { input: form.submissionInput } : {}),
          },
        ),
      ),
    )
    if (Result.isFailure(result)) return graphqlFailure(result.failure.cause)
    if (
      result.success.start.deduplicated ||
      result.success.start.executionId !== executionId
    )
      return toolError("Execution ID is already in use.")
    receipt.started = true
    return started(executionId)
  }).pipe(
    Effect.catch((cause) =>
      Effect.succeed(
        name === recover.name
          ? unknownOutcome()
          : cause instanceof ListUnavailable
            ? toolError("The related Process or List record is not available.")
            : toolError(
                "The runtime did not authorize or return the Process form or catalog.",
              ),
      ),
    ),
  )

const fingerprint = (
  access: McpAccess,
  path: string,
  answers: Record<string, unknown>,
  listContext: typeof ListStartContext.Type | undefined,
) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        access.userId,
        path,
        canonical(answers),
        canonical(listContext),
      ]),
    )
    .digest("base64url")
