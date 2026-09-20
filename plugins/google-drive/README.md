# @processfocus/plugin-google-drive

Google Drive file picker plugin for Process Focus forms.

## Environment Variables

The server-side form walker reads these public Google Picker values from the
runtime environment and sends them to the form renderer through field
`pluginData`. They are intentionally client-visible Picker configuration, not
secret credentials. Next.js does not embed them at build time.

| Variable | Description |
|---|---|
| `GOOGLE_DRIVE_PICKER_CLIENT_ID` | Google OAuth 2.0 client ID (public) |
| `GOOGLE_DRIVE_PICKER_APP_ID` | Google Cloud project number / app ID (public) |
| `GOOGLE_DRIVE_PICKER_DEVELOPER_KEY` | Browser-restricted API key for Google Picker (public) |

Environment configuration changes require a redeploy so the runtime receives
the new values.

Google Cloud must have the Google Drive API and Google Picker API enabled. The
OAuth client must allow the Dashboard origin. Restrict the developer key to the
Dashboard's browser origins and the Google Picker API. The picker requests only
`https://www.googleapis.com/auth/drive.file`.

## Usage

### Process model

```typescript
import {
  GoogleDrive,
  GoogleDriveField,
  parseGoogleDriveGeneratedPdf,
} from "@processfocus/plugin-google-drive"

new GoogleDrive(org, "google-drive")

// In a form schema
const schema = {
  document: GoogleDriveField({
    label: "Tramping plan",
    generatePdf: pdfStore,
  }),
}

// In a later process consumer
const document = parseGoogleDriveGeneratedPdf(state.document)
```

This is the canonical pattern for process documents selected from Google Drive.
The browser exports the selected file as PDF with the user's in-memory OAuth
token, requests a short-lived signed upload URL, and uploads directly to the
configured `DocumentStore` before the form is submitted. The form value contains
only the stored PDF's non-empty `{ fileId, filename }` reference. Process models
use `parseGoogleDriveGeneratedPdf` to validate and consume that reference
directly; no additional system step is needed.

Without `generatePdf`, use `parseGoogleDriveValue` to validate and read the
selected file metadata in a later step.

### Organisation artifact registration

`new GoogleDrive(org, "google-drive")` declares the browser renderer and its
build-time Tailwind stylesheet as organisation artifact inputs. `pfcli build`
emits both as content-addressed, integrity-checked files. Dashboard and public
routes consume those emitted files without resolving this package from the
host runtime.

Importing `GoogleDriveField` registers the walker beside the organisation's
form model, so bundled form projection uses the registry in the organisation
bundle realm. Local and AWS hosts do not import this plugin.

### Low-level frontend registration

The Dashboard's organisation plugin composition activates the browser entrypoint
once before any form renders and injects its host capabilities:

```typescript
import { organisationFrontendPlugin } from "@processfocus/plugin-google-drive/register-client"

organisationFrontendPlugin.activate(host)
```

This registers the React renderer without importing Dashboard or form-registry
source. React and the frontend plugin host contract remain host-provided. The
picker is code-split and only loaded when a Google Drive field is rendered.
Schema walking remains a separate server entrypoint.

The Dashboard wraps authenticated form trees in its organisation plugin host
implementation so `generatePdf` fields can request signed document-store
upload URLs through authenticated GraphQL.

### Server-only (walker only)

If you only need schema walking without React (e.g. server-side):

```typescript
import { registerGoogleDriveWalkerPlugin } from "@processfocus/plugin-google-drive/register-walker"

registerGoogleDriveWalkerPlugin()
```

## Content Security Policy

The plugin loads two external Google scripts at runtime. Your CSP must
allow at minimum:

```
script-src  https://accounts.google.com https://apis.google.com;
frame-src   https://accounts.google.com https://docs.google.com https://drive.google.com;
connect-src https://accounts.google.com https://www.googleapis.com https://docs.google.com https://*.googleusercontent.com;
```

Subresource Integrity (SRI) hashes are not used because both Google
endpoints serve version-less bundles whose content changes without notice.

## How it works

1. `GoogleDriveField` creates an Effect Schema string field annotated with
   `FormGoogleDriveInput`.
2. The walker plugin recognises this annotation and emits a `PluginField`
   node. Public Picker configuration is read from the server runtime and
   sent to the renderer as field `pluginData`.
3. The renderer plugin lazy-loads `GoogleDrivePicker`, which handles its
   own OAuth consent via Google Identity Services (the app's login token
   only has profile/email scopes, not Drive). Scope is
   `https://www.googleapis.com/auth/drive.file`. GIS is hinted with the
   signed-in email and does not force consent after the user has granted
   Drive access.
4. Without `generatePdf`, the selected file metadata is stored as a JSON
   string in the form field.
5. With `generatePdf`, the browser uses the in-memory token to export the first
   tab of a Google Doc through the Docs download endpoint, falling back to the
   Drive export endpoint if needed. Sheets, Slides, and Drawings use Drive
   export, while existing PDFs use the Drive media-download endpoint.
6. The browser requests a short-lived, step-authorized upload URL and uploads
   the PDF bytes directly to the configured `DocumentStore`.
7. Form and process state receive only the stored PDF's `{ fileId, filename }`
   reference. Process models parse this artifact where an attachment or other
   consumer needs it.
8. `parseGoogleDriveGeneratedPdf` validates generated-PDF references, while
   `parseGoogleDriveValue` validates and parses metadata-only values using
   Effect Schema in downstream process steps.

## Credentials

OAuth bearer tokens are kept only in browser module memory for the active page.
An expiry-aware cache lets remounted picker fields reuse a token until one
minute before expiry, and plugin cleanup clears all cached tokens. Tokens must
not be written to browser storage, form values, process state, GraphQL
variables, queues, logs, or database rows. Google export URLs and browser blob
URLs must not be persisted either. Persist only the document-store `fileId` and
safe display metadata such as `filename`.

## Supported PDF sources

PDF generation accepts Google Docs, Sheets, Slides, Drawings, and existing PDF
files. The picker filters out other MIME types. If another Google Drive type is
needed, first confirm that Drive can export it as `application/pdf`; do not add
a server-side token transfer as a workaround.
