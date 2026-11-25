import { Schema } from "effect"
import { getFrontendJwt } from "@pf/auth-session"
import type { LookupSuggestion } from "@pf/form"
import { FormRequestData } from "@pf/form-schema"
import { publicTodoDefaultValues } from "./anonymous-page-form-values"
import type { AnonymousPageQuery } from "./generated/gql/graphql"
import {
  anonymousPageLookupQuery,
  anonymousPageQuery,
  submitAnonymousPageMutation,
} from "./graphql/anonymous-page"
import { createServerGraphqlClient } from "./graphql/server-client"

const client = () => {
  const jwt = getFrontendJwt()
  if (!jwt) throw new Error("FRONTEND_JWT_TOKEN is not configured")
  return createServerGraphqlClient(jwt)
}

export type AnonymousPageData = Omit<
  AnonymousPageQuery["anonymousPage"],
  "requestData" | "defaultValues" | "pluginConfiguration"
> & {
  requestData: FormRequestData
  defaultValues: Record<string, unknown>
  pluginConfiguration: Readonly<Record<string, unknown>>
}

export async function fetchAnonymousPage(
  address: string,
): Promise<AnonymousPageData> {
  const { anonymousPage: page } = await client().request(anonymousPageQuery, {
    address,
  })
  return {
    ...page,
    requestData: Schema.decodeUnknownSync(FormRequestData)(page.requestData),
    pluginConfiguration: Schema.decodeUnknownSync(
      Schema.Record(Schema.String, Schema.Unknown),
    )(page.pluginConfiguration),
    defaultValues: publicTodoDefaultValues(page.defaultValues) ?? {},
  }
}

export async function lookupAnonymousPage(args: {
  address: string
  field: string
  filter: string
  limit: number
  selectedValue?: string
}): Promise<LookupSuggestion[]> {
  const data = await client().request(anonymousPageLookupQuery, args)
  return data.anonymousPageLookup.map(({ value, label, searchText }) => ({
    value,
    label,
    ...(searchText != null && { searchText }),
  }))
}

export async function submitAnonymousPage(
  address: string,
  input: Record<string, unknown>,
): Promise<void> {
  await client().request(submitAnonymousPageMutation, { address, input })
}
