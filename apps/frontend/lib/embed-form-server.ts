import "server-only"
import { Schema } from "effect"
import { getFrontendJwt } from "@pf/auth-session"
import { FormRequestData } from "@pf/form-schema"
import { graphql } from "./generated/gql"
import { createServerGraphqlClient } from "./graphql/server-client"

const embeddedFormDataQuery = graphql(`
  query EmbeddedFormData($stepPath: String!) {
    embeddedFormMetadata(stepPath: $stepPath) {
      defaultValues
      requestData
      pluginConfiguration
    }
  }
`)

const dataSchema = Schema.Struct({
  defaultValues: Schema.Record(Schema.String, Schema.Unknown),
  requestData: FormRequestData,
  pluginConfiguration: Schema.Record(Schema.String, Schema.Unknown),
})
export type EmbedFormData = typeof dataSchema.Type

export async function fetchEmbedFormData(
  stepPath: string,
): Promise<EmbedFormData> {
  const jwt = getFrontendJwt()
  if (!jwt) throw new Error("FRONTEND_JWT_TOKEN is not configured")
  const data = await createServerGraphqlClient(jwt).request(
    embeddedFormDataQuery,
    { stepPath },
  )
  return Schema.decodeUnknownSync(dataSchema)(data.embeddedFormMetadata)
}
