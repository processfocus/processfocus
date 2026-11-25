"use client"

import { useQuery } from "@tanstack/react-query"
import { Schema } from "effect"
import { FormRequestData } from "@pf/form-schema"
import type {
  FormMetadataQuery,
  FormMetadataQueryVariables,
} from "@/lib/generated/gql/graphql"
import { useGraphqlClient } from "@/lib/graphql/client-provider"
import { FORM_METADATA_QUERY } from "@/lib/graphql/queries"

const formMetadataCacheTime =
  process.env["NODE_ENV"] === "development" ? 0 : Number.POSITIVE_INFINITY

type ParsedFormMetadata = Omit<
  NonNullable<FormMetadataQuery["formMetadata"]>,
  "pluginConfiguration"
> & {
  readonly pluginConfiguration: Readonly<Record<string, unknown>>
  readonly requestData: FormRequestData | null
}

interface UseFormMetadataResult {
  formMetadata: ParsedFormMetadata | null
  isLoading: boolean
  error: Error | null
}

/**
 * Hook to fetch form metadata for a step path.
 * Makes a GraphQL request to get the form schema, mutation names, and default values.
 * Authentication is handled automatically via cookies (credentials: "include").
 *
 * @param stepPath - Path to the step (format: orgUnit/processName/stepName)
 * @param todoId - Optional todo ID for resolving state-based default values
 */
export const useFormMetadata = (
  stepPath: string,
  todoId?: string,
): UseFormMetadataResult => {
  const client = useGraphqlClient()

  const { data, isLoading, error } = useQuery({
    queryKey: ["formMetadata", stepPath, todoId],
    queryFn: async () => {
      const result = await client.request<
        FormMetadataQuery,
        FormMetadataQueryVariables
      >(FORM_METADATA_QUERY, { stepPath, todoId })

      const metadata = result.formMetadata
      if (!metadata) return null

      return {
        ...metadata,
        requestData:
          metadata.requestData == null
            ? null
            : Schema.decodeUnknownSync(FormRequestData)(metadata.requestData),
        pluginConfiguration:
          metadata.pluginConfiguration == null
            ? {}
            : parsePluginConfiguration(metadata.pluginConfiguration),
      }
    },
    retry: false,
    staleTime: formMetadataCacheTime,
    gcTime: formMetadataCacheTime,
  })

  return {
    formMetadata: data ?? null,
    isLoading,
    error: error ?? null,
  }
}

function parsePluginConfiguration(
  value: unknown,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("formMetadata.pluginConfiguration must be an object")
  return { ...value }
}
