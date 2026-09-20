/**
 * Plugin-owned annotation symbol for Google Drive file selection fields.
 * This symbol is not in core — it belongs entirely to the plugin.
 */
export const FormGoogleDriveInput = Symbol.for(
  "pf/form/annotation/GoogleDriveInput",
)

/**
 * Annotation symbol indicating this field should generate a PDF export.
 * Its metadata identifies the DocumentStore that receives the browser export.
 */
export const FormGoogleDriveGeneratePdf = Symbol.for(
  "pf/form/annotation/GoogleDriveGeneratePdf",
)
