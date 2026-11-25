import { Form, type OrgUnit, Process, type Role } from "@pf/process"
import { uploadDocumentForm } from "./file-upload-test-forms"

export class FileUploadTest extends Process {
  constructor(scope: OrgUnit, id: string, props: { role: Role }) {
    super(scope, id, {
      name: "File Upload Test",
      purpose: "Test file upload and download permissions",
    })

    const upload = new Form(this, "Upload document", {
      name: "Upload a test document",
      form: uploadDocumentForm,
      browser: {
        entrypoint: "src/file-upload-test-forms.ts",
        exportName: "uploadDocumentForm",
      },
      role: props.role,
    })

    this.start(upload).end()
  }
}
