"use client"

import { useQuery } from "@tanstack/react-query"
import { ClientError } from "graphql-request"
import { useState } from "react"
import type { FieldError, FormActionsContext } from "@pf/form"
import { Button } from "@pf/shadcn-components"
import { ListSchemaForm } from "./list-schema-form"
import { useListRefresh } from "@/app/(protected)/lists/lib/list-refresh-provider"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useGraphqlClient } from "@/lib/graphql/client-provider"
import {
  assertGraphqlName,
  listCreateFormMetadataQuery,
} from "@/lib/graphql/list-queries"
import { LookupClientProvider } from "@/lib/graphql/lookup-provider"

function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null
}

export function ListCreateButton({
  listPath,
  name,
}: {
  listPath: string
  name: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button onClick={() => setOpen(true)}>Create record</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Create {name}</DialogTitle>
          </DialogHeader>
          {open ? (
            <ListCreateForm
              listPath={listPath}
              onClose={() => setOpen(false)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  )
}

function ListCreateForm({
  listPath,
  onClose,
}: {
  listPath: string
  onClose: () => void
}) {
  const client = useGraphqlClient()
  const refreshState = useListRefresh()
  const metadata = useQuery({
    queryKey: ["list-create-form", listPath],
    queryFn: async () =>
      (await client.request(listCreateFormMetadataQuery, { listPath }))
        .listCreateFormMetadata,
  })
  if (metadata.isPending) return <p>Loading form…</p>
  if (metadata.isError)
    return (
      <p role="alert">
        Could not load the form.{" "}
        <Button onClick={() => metadata.refetch()}>Retry</Button>
      </p>
    )
  if (!metadata.data)
    return <p role="alert">You cannot create records in this List.</p>
  const data = metadata.data
  const options = {
    draftId: `list-create-${listPath}`,
    defaultValues: objectValue(data.defaultValues),
    handleSubmit: async (
      values: Record<string, unknown>,
    ): Promise<FieldError[] | undefined> => {
      assertGraphqlName(data.createMutationName, "mutation name")
      assertGraphqlName(data.createInputTypeName, "input type name")
      try {
        await client.request(
          `mutation CreateListItem($input: ${data.createInputTypeName}!) { ${data.createMutationName}(input: $input) }`,
          { input: values },
        )
        refreshState.invalidate(listPath)
        onClose()
        return undefined
      } catch (error) {
        if (error instanceof ClientError) {
          const extensions = error.response.errors?.[0]?.extensions
          const errors = extensions?.["errors"]
          if (
            extensions?.["code"] === "InputValidationError" &&
            Array.isArray(errors)
          ) {
            const fieldErrors: FieldError[] = []
            for (const item of errors) {
              if (
                typeof item === "object" &&
                item !== null &&
                "field" in item &&
                "message" in item &&
                typeof item.field === "string" &&
                typeof item.message === "string"
              ) {
                fieldErrors.push({ field: item.field, message: item.message })
              }
            }
            if (fieldErrors.length) return fieldErrors
          }
        }
        return [
          {
            field: "",
            message: "Could not create the record. Please try again.",
          },
        ]
      }
    },
    renderActions: ({ formState }: FormActionsContext) => (
      <div className="flex justify-end gap-3">
        <Button
          type="button"
          variant="outline"
          onClick={onClose}
          disabled={formState.isSubmitting}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={formState.isSubmitting}>
          {formState.isSubmitting ? "Creating…" : "Create"}
        </Button>
      </div>
    ),
  }
  const formPath = `${listPath}/create`
  return (
    <LookupClientProvider listCreate>
      <ListSchemaForm
        formPath={formPath}
        draftId={options.draftId}
        defaultValues={options.defaultValues ?? {}}
        onSubmit={options.handleSubmit}
      >
        {options.renderActions}
      </ListSchemaForm>
    </LookupClientProvider>
  )
}
