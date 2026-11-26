import { Schema } from "effect"
import { FileField } from "@pf/form-schema"

export const testDocumentsId = "test-documents"
export const uploadDocumentForm = Schema.Struct({
  fileId: FileField({
    label: "Document",
    documentStore: { node: { path: `/${testDocumentsId}` } },
  }),
})
