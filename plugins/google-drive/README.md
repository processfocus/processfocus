# @processfocus/plugin-google-drive

Adds a Google Drive file picker to Process Focus forms. Forms can keep selected
file metadata or save a PDF copy to a Document Store.

## Setup

Enable the Google Drive and Google Picker APIs in Google Cloud. Configure the
OAuth client for your Dashboard origin and restrict the browser API key to that
origin and the Picker API.

| Runtime setting | Value |
| --- | --- |
| `GOOGLE_DRIVE_PICKER_CLIENT_ID` | Public OAuth client ID |
| `GOOGLE_DRIVE_PICKER_APP_ID` | Google Cloud project number |
| `GOOGLE_DRIVE_PICKER_DEVELOPER_KEY` | Browser-restricted Picker API key |

These settings are browser-visible. Missing configuration leaves the picker
unavailable. Redeploy after changing hosted configuration.

## Use in an organisation

```ts
import {
  GoogleDrive,
  GoogleDriveConfiguration,
  GoogleDriveField,
} from "@processfocus/plugin-google-drive"

new GoogleDrive(org, "google-drive")
export const Configuration = { version: 1, groups: [GoogleDriveConfiguration] }

const fields = {
  document: GoogleDriveField({ label: "Document", generatePdf: pdfStore }),
}
```

Here `org` is the organisation and `pdfStore` is its Document Store. The
`GoogleDrive` construct packages the renderer and stylesheet with the organisation.

With `generatePdf`, the form saves a PDF and returns a stored-file reference.
Use `parseGoogleDriveGeneratedPdf` to read it in later process steps. PDF sources
can be Google Docs, Sheets, Slides, Drawings or existing PDFs.

Omit `generatePdf` to retain selected-file metadata instead, read with
`parseGoogleDriveValue`. Drive access uses the person's browser consent with the
`drive.file` scope; OAuth tokens are not part of the saved form value.

## Shared browser forms

Import fields and parsers from `@processfocus/plugin-google-drive/field` in
browser-shared form modules. Keep the `GoogleDrive` construct on the server.
Supply public Picker settings through the Form's
`browser.resolvePluginConfiguration`, keyed by the submitted field path, using
`readGoogleDrivePickerConfiguration`.

## Content Security Policy

Self-managed frontends must allow the Google scripts, frames and requests:

```text
script-src  https://accounts.google.com https://apis.google.com;
frame-src   https://accounts.google.com https://docs.google.com https://drive.google.com;
connect-src https://accounts.google.com https://www.googleapis.com https://docs.google.com https://*.googleusercontent.com;
```
