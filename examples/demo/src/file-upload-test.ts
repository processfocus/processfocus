import { FileField } from "@pf/form-schema"
import {
  type DocumentStore,
  Form,
  type OrgUnit,
  Process,
  type Role,
} from "@pf/process"

export class FileUploadTest extends Process {
  constructor(
    scope: OrgUnit,
    id: string,
    props: { role: Role; documentStore: DocumentStore },
  ) {
    super(scope, id, {
      name: "File Upload Test",
      purpose: "Test file upload and download permissions",
    })

    const upload = new Form(this, "Upload document", {
      name: "Upload a test document",
      form: () => ({
        fileId: FileField({
          label: "Document",
          documentStore: props.documentStore,
        }),
      }),
      role: props.role,
    })

    this.start(upload).end()
  }
}
