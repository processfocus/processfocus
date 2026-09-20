import {
  GoogleDrive,
  GoogleDriveField,
  parseGoogleDriveGeneratedPdf,
  parseGoogleDriveValue,
} from "@processfocus/plugin-google-drive"
import { organisationFrontendPlugin } from "@processfocus/plugin-google-drive/client"
import { registerGoogleDriveWalkerPlugin } from "@processfocus/plugin-google-drive/register-walker"
import { DocumentStore, OrgUnit, Organisation } from "processfocus"

const org = new Organisation({ name: "Plugin Fixture" })
const unit = new OrgUnit(org, "Operations", { name: "Operations" })
const store = new DocumentStore(org, "Documents")
const googleDrive = new GoogleDrive(org, "GoogleDrive")
const metadataField = GoogleDriveField({ label: "Plan" })
const generatedPdfField = GoogleDriveField({
  label: "Plan PDF",
  generatePdf: store,
})
const metadata = parseGoogleDriveValue(
  JSON.stringify({
    id: "file-1",
    name: "plan.pdf",
    mimeType: "application/pdf",
    url: "https://drive.google.com/file/d/file-1",
  }),
)
const generatedPdf = parseGoogleDriveGeneratedPdf(
  JSON.stringify({ fileId: "stored-file-1", filename: "plan.pdf" }),
)

registerGoogleDriveWalkerPlugin()
organisationFrontendPlugin.activate({
  kind: "organisation-plugin-host",
  interfaceVersion: 1,
  analytics: { register: () => () => undefined },
  formRenderers: { register: () => () => undefined },
  executionMenu: { register: () => () => undefined },
  graphql: { ClientConsumer: () => null },
})

if (
  !metadataField ||
  !generatedPdfField ||
  metadata.id !== "file-1" ||
  generatedPdf.fileId !== "stored-file-1" ||
  organisationFrontendPlugin.id !== "google-drive" ||
  googleDrive.node.path.length === 0 ||
  unit.node.path.length === 0
) {
  throw new Error("Google Drive plugin public surfaces failed")
}
