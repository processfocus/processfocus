import type React from "react"
import { Suspense, lazy } from "react"
import type {
  FrontendPluginField,
  GraphqlRequester,
  OrganisationFrontendPlugin,
} from "@pf/frontend-plugin-host"
import type { GoogleDrivePluginData } from "./plugin-data"
import { GOOGLE_DRIVE_PLUGIN_TYPE } from "./plugin-identity"

/** Lazy-loaded picker component — only fetched when a Google Drive field renders. */
const LazyGoogleDrivePicker = lazy(() =>
  import("./google-drive-picker").then((m) => ({
    default: m.GoogleDrivePicker,
  })),
)

interface UploadUrlResponse {
  readonly requestUploadUrl: {
    readonly fileId: string
    readonly uploadUrl: string
  }
}

interface DownloadUrlResponse {
  readonly requestDownloadUrl: {
    readonly downloadUrl: string
  }
}

const REQUEST_UPLOAD_URL_MUTATION = `
  mutation GoogleDriveRequestUploadUrl($stepPath: String!, $documentStore: String!, $contentType: String, $filename: String) {
    requestUploadUrl(stepPath: $stepPath, documentStore: $documentStore, contentType: $contentType, filename: $filename) {
      fileId
      uploadUrl
    }
  }
`

const REQUEST_DOWNLOAD_URL_QUERY = `
  query GoogleDriveRequestDownloadUrl($stepPath: String!, $documentStore: String!, $fileId: String!) {
    requestDownloadUrl(stepPath: $stepPath, documentStore: $documentStore, fileId: $fileId) {
      downloadUrl
    }
  }
`

const DELETE_FILE_MUTATION = `
  mutation GoogleDriveDeleteFile($fileId: ID!) {
    deleteFile(fileId: $fileId) {
      success
    }
  }
`

const requestUploadUrl = async (
  graphqlClient: GraphqlRequester,
  input: {
    readonly stepPath: string
    readonly documentStore: string
    readonly contentType: string
    readonly filename: string
  },
) => {
  const data = await graphqlClient.request<UploadUrlResponse>(
    REQUEST_UPLOAD_URL_MUTATION,
    input,
  )
  return data.requestUploadUrl
}

const deleteFile = async (
  graphqlClient: GraphqlRequester,
  fileId: string,
): Promise<void> => {
  await graphqlClient.request(DELETE_FILE_MUTATION, { fileId })
}

const requestDownloadUrl = async (
  graphqlClient: GraphqlRequester,
  input: {
    readonly stepPath: string
    readonly documentStore: string
    readonly fileId: string
  },
): Promise<{ readonly downloadUrl: string }> => {
  const data = await graphqlClient.request<DownloadUrlResponse>(
    REQUEST_DOWNLOAD_URL_QUERY,
    input,
  )
  return data.requestDownloadUrl
}

/**
 * Register the Google Drive plugin renderer.
 *
 * Call this at frontend startup — before any form is rendered.
 * The picker component itself is code-split and only loaded on demand.
 */
export const organisationFrontendPlugin = {
  id: GOOGLE_DRIVE_PLUGIN_TYPE,
  activate: (host) => {
    host.formRenderers.register({
      type: GOOGLE_DRIVE_PLUGIN_TYPE,
      renderer: (
        form: {
          AppField: React.ComponentType<{
            name: string
            children: () => React.JSX.Element
          }>
        },
        component: FrontendPluginField,
        shouldAutoFocus: boolean,
        options?: { readonly todoId?: string; readonly stepPath?: string },
      ) => {
        const AppField = form.AppField as React.ComponentType<{
          readonly name: string
          readonly children: (field: {
            readonly state: { readonly value: string }
            readonly handleChange: (value: string) => void
          }) => React.JSX.Element
        }>
        const pluginData = component.pluginData as
          | GoogleDrivePluginData
          | undefined
        return (
          <AppField key={component.field} name={component.field}>
            {(field) => (
              <Suspense
                fallback={
                  <div className="animate-pulse space-y-2">
                    <div className="bg-muted h-4 w-1/3 rounded" />
                    <div className="bg-muted h-10 w-32 rounded" />
                  </div>
                }
              >
                <host.graphql.ClientConsumer>
                  {(graphqlClient) => {
                    const picker = (hint?: string) => (
                      <LazyGoogleDrivePicker
                        field={field}
                        label={component.label}
                        autoFocus={shouldAutoFocus}
                        requestUploadUrl={(input) =>
                          requestUploadUrl(graphqlClient, input)
                        }
                        requestDownloadUrl={(input) =>
                          requestDownloadUrl(graphqlClient, input)
                        }
                        deleteFile={(fileId) =>
                          deleteFile(graphqlClient, fileId)
                        }
                        {...(pluginData?.clientId !== undefined && {
                          clientId: pluginData.clientId,
                        })}
                        {...(pluginData?.appId !== undefined && {
                          appId: pluginData.appId,
                        })}
                        {...(pluginData?.developerKey !== undefined && {
                          developerKey: pluginData.developerKey,
                        })}
                        {...(pluginData?.generatePdf !== undefined && {
                          generatePdf: pluginData.generatePdf,
                        })}
                        {...(hint !== undefined &&
                          hint !== "" && {
                            hint,
                          })}
                        {...(options?.stepPath !== undefined && {
                          stepPath: options.stepPath,
                        })}
                        {...(component.description !== undefined && {
                          description: component.description,
                        })}
                        {...(component.readonly !== undefined && {
                          readOnly: component.readonly,
                        })}
                      />
                    )
                    if (!host.session) {
                      return picker()
                    }
                    return (
                      <host.session.Consumer>
                        {(session) => picker(session.email)}
                      </host.session.Consumer>
                    )
                  }}
                </host.graphql.ClientConsumer>
              </Suspense>
            )}
          </AppField>
        )
      },
    })
  },
} satisfies OrganisationFrontendPlugin
