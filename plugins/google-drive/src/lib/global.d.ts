/**
 * Global type augmentations for Google Drive plugin.
 *
 * Custom JSX elements for @googleworkspace/drive-picker-element.
 *
 * NOTE: The authoritative augmentation now lives inline in
 * google-drive-picker.tsx because Next.js incremental mode does not
 * pick up standalone .d.ts augmentation files from referenced projects.
 * This file is kept for IDE support within the plugin itself.
 */

import type React from "react"

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "drive-picker": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          "app-id"?: string
          "client-id"?: string
          "developer-key"?: string
          "oauth-token"?: string
          mime?: string
          multiselect?: boolean
        },
        HTMLElement
      >
      "drive-picker-docs-view": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & {
          "include-folders"?: string
          "mime-types"?: string
        },
        HTMLElement
      >
    }
  }
}
