import { ClientError } from "graphql-request"
import { type NextRequest, NextResponse } from "next/server"
import { getFrontendJwt } from "@pf/auth-session"
import type { CalendarSlotItem, LookupSuggestion } from "@pf/form"
import { FormComponentType } from "@pf/form-client-representation/types"
import {
  findEmbedLookupDefinitionByField,
  findEmbedLookupDefinitionByQueryName,
} from "@/lib/embed-manifest"
import { getEmbedManifestEntry } from "@/lib/embed-manifest-store"
import { isAllowedEmbedOrigin } from "@/lib/embed-request-origin"
import { isGraphqlIdentifier } from "@/lib/graphql/graphql-identifiers"
import { createServerGraphqlClient } from "@/lib/graphql/server-client"

interface EmbedLookupBody {
  readonly stepPath?: unknown
  readonly field?: unknown
  readonly filter?: unknown
  readonly limit?: unknown
  readonly queryName?: unknown
  readonly input?: unknown
}

const LOOKUP_SUGGESTIONS_QUERY = `
  query LookupSuggestions($stepPath: String!, $field: String!, $filter: String, $limit: Int) {
    lookupSuggestions(stepPath: $stepPath, field: $field, filter: $filter, limit: $limit) {
      value
      label
    }
  }
`

const CALENDAR_SLOTS_QUERY = `
  query CalendarSlots($stepPath: String!, $field: String!) {
    calendarSlots(stepPath: $stepPath, field: $field) {
      value
      label
      startsAt
      endsAt
    }
  }
`

const DEFAULT_LOOKUP_LIMIT = 20
const MAX_LOOKUP_LIMIT = 100
const LOOKUP_FAILURE_MESSAGE =
  "Unable to load lookup suggestions. Please try again."

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const parseLimit = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_LOOKUP_LIMIT
  }

  return Math.min(Math.max(Math.trunc(value), 1), MAX_LOOKUP_LIMIT)
}

const parseLookupInput = (value: unknown): Record<string, string> | null => {
  if (value == null) {
    return {}
  }

  if (!isRecord(value)) {
    return null
  }

  const input: Record<string, string> = {}
  for (const [key, inputValue] of Object.entries(value)) {
    if (typeof inputValue !== "string") {
      return null
    }
    input[key] = inputValue
  }

  return input
}

const buildDependentLookupQuery = (
  queryName: string,
  dependencies: readonly string[],
): string => {
  // The route only interpolates manifest-derived identifiers after validating
  // that they match GraphQL identifier syntax.
  const variableDefinitions = [
    "$filter: String",
    ...dependencies.map((dep) => `$${dep}: String!`),
    "$limit: Int",
  ].join(", ")
  const inputFields = [
    "filter: $filter",
    ...dependencies.map((dep) => `${dep}: $${dep}`),
  ].join(", ")

  return `
    query EmbeddedDependentLookup(${variableDefinitions}) {
      ${queryName}(input: { ${inputFields} }, limit: $limit) {
        value
        label
      }
    }
  `
}

export const POST = async (request: NextRequest): Promise<Response> => {
  const body = (await request
    .json()
    .catch(() => null)) as EmbedLookupBody | null
  const stepPath = typeof body?.stepPath === "string" ? body.stepPath : null

  if (!stepPath) {
    return NextResponse.json(
      { error: "Invalid embed lookup payload." },
      { status: 400 },
    )
  }

  const entry = getEmbedManifestEntry(stepPath)
  if (!entry) {
    return NextResponse.json(
      { error: "Embedded form not found." },
      { status: 404 },
    )
  }

  if (
    !isAllowedEmbedOrigin(request.headers, entry.sites, request.nextUrl.origin)
  ) {
    return NextResponse.json(
      { error: "Embed lookup origin is not allowed." },
      { status: 403 },
    )
  }

  const frontendJwt = getFrontendJwt()
  if (!frontendJwt) {
    return NextResponse.json(
      { error: "FRONTEND_JWT_TOKEN is not configured." },
      { status: 500 },
    )
  }

  const client = createServerGraphqlClient(frontendJwt)
  const limit = parseLimit(body?.limit)

  try {
    if (typeof body?.field === "string") {
      const filter = typeof body?.filter === "string" ? body.filter : ""
      const lookup = findEmbedLookupDefinitionByField(
        entry.formDefinition,
        body.field,
      )

      if (!lookup) {
        return NextResponse.json(
          { error: "Lookup field is not available for this embedded form." },
          { status: 403 },
        )
      }

      if (lookup.type === FormComponentType.CalendarSlot) {
        const data = await client.request<{
          calendarSlots: CalendarSlotItem[]
        }>(CALENDAR_SLOTS_QUERY, {
          stepPath,
          field: body.field,
        })

        return NextResponse.json({ items: data.calendarSlots })
      }

      const data = await client.request<{
        lookupSuggestions: LookupSuggestion[]
      }>(LOOKUP_SUGGESTIONS_QUERY, {
        stepPath,
        field: body.field,
        filter,
        limit,
      })

      return NextResponse.json({ items: data.lookupSuggestions })
    }

    if (typeof body?.queryName !== "string") {
      return NextResponse.json(
        { error: "Invalid embed lookup payload." },
        { status: 400 },
      )
    }

    const lookup = findEmbedLookupDefinitionByQueryName(
      entry.formDefinition,
      body.queryName,
    )
    if (!lookup) {
      return NextResponse.json(
        { error: "Lookup query is not available for this embedded form." },
        { status: 403 },
      )
    }

    const input = parseLookupInput(body.input)
    if (input === null) {
      return NextResponse.json(
        { error: "Invalid embed lookup payload." },
        { status: 400 },
      )
    }

    const allowedKeys = new Set(["filter", ...lookup.dependencies])
    if (Object.keys(input).some((key) => !allowedKeys.has(key))) {
      return NextResponse.json(
        { error: "Invalid embed lookup payload." },
        { status: 400 },
      )
    }

    if (
      lookup.dependencies.some((dependency) => input[dependency] === undefined)
    ) {
      return NextResponse.json(
        { error: "Missing dependent lookup values." },
        { status: 400 },
      )
    }

    const queryName = body.queryName
    if (
      !isGraphqlIdentifier(queryName) ||
      lookup.dependencies.some((dependency) => !isGraphqlIdentifier(dependency))
    ) {
      return NextResponse.json(
        { error: LOOKUP_FAILURE_MESSAGE },
        { status: 500 },
      )
    }

    const query = buildDependentLookupQuery(queryName, lookup.dependencies)
    const variables: Record<string, unknown> = {
      filter: input["filter"] ?? "",
      limit,
    }
    for (const dependency of lookup.dependencies) {
      variables[dependency] = input[dependency]
    }

    const data = await client.request<Record<string, LookupSuggestion[]>>(
      query,
      variables,
    )

    return NextResponse.json({ items: data[queryName] ?? [] })
  } catch (error) {
    if (error instanceof ClientError) {
      console.error("Embed lookup GraphQL request failed", error)
      return NextResponse.json(
        { error: LOOKUP_FAILURE_MESSAGE },
        { status: 502 },
      )
    }

    console.error("Embed lookup request failed", error)
    return NextResponse.json({ error: LOOKUP_FAILURE_MESSAGE }, { status: 500 })
  }
}
