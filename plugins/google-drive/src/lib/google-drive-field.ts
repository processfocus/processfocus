import { Option, Schema } from "effect"
import {
  type FieldOptions,
  FormComponentPluginType,
  FormFileInput,
  applyFieldAnnotations,
} from "@pf/form-schema"
import {
  FormGoogleDriveGeneratePdf,
  FormGoogleDriveInput,
} from "./google-drive-annotations"
import {
  GOOGLE_DRIVE_CLIENT_MODULE,
  GOOGLE_DRIVE_PLUGIN_TYPE,
} from "./plugin-identity"
import { registerGoogleDriveWalkerPlugin } from "./register-walker"

export { FormGoogleDriveGeneratePdf, FormGoogleDriveInput }

// Organisation bundles contain their own runtime plugin registry. Registering
// while the field module loads keeps the walker and its registry in that same
// JavaScript realm, even when the host runtime has a separate registry copy.
registerGoogleDriveWalkerPlugin()

/**
 * Extended options for GoogleDriveField.
 *
 * When `generatePdf` is set to a DocumentStore construct, the browser exports
 * the selected Drive file and uploads the PDF directly to that store. The
 * OAuth token remains in browser memory.
 */
export interface GoogleDriveFieldOptions extends FieldOptions<string> {
  /**
   * Pass the DocumentStore that should receive the browser-generated PDF.
   * The field value stores the resulting file id and filename, never the
   * Google OAuth token.
   */
  readonly generatePdf?: { readonly node: { readonly path: string } }
}

/** Stored document reference produced by the browser PDF upload flow. */
export const GoogleDriveGeneratedPdfSchema = Schema.Struct({
  fileId: Schema.NonEmptyString,
  filename: Schema.NonEmptyString,
})

export type GoogleDriveGeneratedPdf = typeof GoogleDriveGeneratedPdfSchema.Type

const GoogleDriveGeneratedPdfJsonSchema = Schema.parseJson(
  GoogleDriveGeneratedPdfSchema,
)

/** Parse a generated-PDF form value into its stored document reference. */
export const parseGoogleDriveGeneratedPdf = (
  value: string,
): GoogleDriveGeneratedPdf =>
  Schema.decodeUnknownSync(GoogleDriveGeneratedPdfJsonSchema, {
    onExcessProperty: "error",
  })(value)

/** Return whether a form value is exactly a generated-PDF document reference. */
export const isGoogleDriveGeneratedPdf = (value: string): boolean =>
  Option.isSome(
    Schema.decodeUnknownOption(GoogleDriveGeneratedPdfJsonSchema, {
      onExcessProperty: "error",
    })(value),
  )

/**
 * Create a Google Drive file selection field.
 *
 * Stores a JSON-encoded string of file metadata or, when generatePdf is set,
 * only the generated PDF's document-store reference. It never stores a bearer
 * token.
 * Use `parseGoogleDriveValue` in process models to extract structured data.
 *
 * @example
 * ```typescript
 * const schema = Schema.Struct({
 *   document: GoogleDriveField({ label: "Select document" })
 * })
 * ```
 */
export const GoogleDriveField = (
  options?: GoogleDriveFieldOptions,
): Schema.Schema<string, string, never> => {
  const documentStore = options?.generatePdf?.node.path
  const normalizedDocumentStore = documentStore?.startsWith("/")
    ? documentStore
    : documentStore === undefined
      ? undefined
      : `/${documentStore}`

  const valueSchema =
    normalizedDocumentStore === undefined
      ? Schema.String
      : Schema.String.pipe(
          Schema.filter(isGoogleDriveGeneratedPdf, {
            message: () =>
              "Select a Google Drive file and wait for its PDF upload to finish",
          }),
        )

  return applyFieldAnnotations(
    valueSchema.annotations({
      [FormComponentPluginType]: {
        module: GOOGLE_DRIVE_CLIENT_MODULE,
        type: GOOGLE_DRIVE_PLUGIN_TYPE,
      },
      [FormGoogleDriveInput]: true,
      ...(normalizedDocumentStore !== undefined && {
        [FormGoogleDriveGeneratePdf]: {
          documentStore: normalizedDocumentStore,
        },
        [FormFileInput]: { documentStore: normalizedDocumentStore },
      }),
    }),
    options,
  )
}

/**
 * Schema for validated Google Drive file metadata.
 * Public process-state values never include bearer tokens.
 */
export const DrivePickerFileSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  url: Schema.String,
})

export type DrivePickerFile = typeof DrivePickerFileSchema.Type

/**
 * Parse a Google Drive value string into validated file metadata.
 * Throws a ParseError if the JSON is malformed or missing required fields.
 *
 * @example
 * ```typescript
 * const file = parseGoogleDriveValue(formValue)
 * console.log(file.name, file.url)
 * ```
 */
export const parseGoogleDriveValue = (value: string): DrivePickerFile =>
  Schema.decodeUnknownSync(Schema.parseJson(DrivePickerFileSchema), {
    onExcessProperty: "error",
  })(value)
