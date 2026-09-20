import type React from "react"
import {
  cleanupAllPlugins,
  getMatchingPlugin,
  unregisterWalkerPlugin,
} from "@pf/form-client-representation"
import type {
  FormRendererRegistration,
  FrontendPluginField,
  FrontendPluginSessionConsumerProps,
  OrganisationFrontendPluginHost,
} from "@pf/frontend-plugin-host"
import {
  FormGoogleDriveGeneratePdf,
  FormGoogleDriveInput,
} from "./google-drive-field"
import {
  GOOGLE_DRIVE_CLIENT_MODULE,
  GOOGLE_DRIVE_PLUGIN_TYPE,
} from "./plugin-identity"
import { organisationFrontendPlugin } from "./register-client"
import { registerGoogleDriveWalkerPlugin } from "./register-walker"
import { afterEach, describe, expect, it } from "bun:test"

const forbiddenBrowserModule =
  /(?:^|\/)(?:apps\/frontend|job-worker|server-only)(?:\/|$)|(?:^|\/)(?:@aws-sdk|@effect|aws-cdk-lib|drizzle-orm|effect)(?:[+@/]|$)/

const createHost = (
  register: (renderer: FormRendererRegistration) => () => void,
  sessionEmail?: string,
): OrganisationFrontendPluginHost => ({
  kind: "organisation-plugin-host",
  interfaceVersion: 1,
  analytics: { register: () => () => {} },
  formRenderers: { register },
  executionMenu: { register: () => () => {} },
  graphql: { ClientConsumer: () => null },
  ...(sessionEmail !== undefined && {
    session: {
      Consumer: ({ children }: FrontendPluginSessionConsumerProps) =>
        children({ email: sessionEmail }),
    },
  }),
})

const pickerEnvKeys = [
  "GOOGLE_DRIVE_PICKER_CLIENT_ID",
  "GOOGLE_DRIVE_PICKER_APP_ID",
  "GOOGLE_DRIVE_PICKER_DEVELOPER_KEY",
] as const

const originalPickerEnv = Object.fromEntries(
  pickerEnvKeys.map((key) => [key, process.env[key]]),
)

const restorePickerEnv = (): void => {
  for (const key of pickerEnvKeys) {
    const original = originalPickerEnv[key]
    if (original === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = original
    }
  }
}

const clearPickerEnv = (): void => {
  for (const key of pickerEnvKeys) {
    delete process.env[key]
  }
}

afterEach(() => {
  unregisterWalkerPlugin(GOOGLE_DRIVE_PLUGIN_TYPE)
  restorePickerEnv()
})

describe("trusted Google Drive browser entrypoint", () => {
  it("owns stable registration and manifest identities", () => {
    expect(organisationFrontendPlugin.id).toBe(GOOGLE_DRIVE_PLUGIN_TYPE)
    expect(GOOGLE_DRIVE_CLIENT_MODULE).toBe(
      "@processfocus/plugin-google-drive/register-client",
    )

    let registration: FormRendererRegistration | undefined
    organisationFrontendPlugin.activate(
      createHost((renderer) => {
        registration = renderer
        return () => {}
      }),
    )

    expect(registration!.type).toBe(GOOGLE_DRIVE_PLUGIN_TYPE)
  })

  it("passes picker configuration and upload context to the lazy renderer", () => {
    let registration: FormRendererRegistration | undefined
    organisationFrontendPlugin.activate(
      createHost((renderer) => {
        registration = renderer
        return () => {}
      }),
    )

    const AppField = ({
      children,
    }: {
      children: (field: {
        readonly state: { readonly value: string }
        readonly handleChange: (value: string) => void
      }) => React.JSX.Element
    }) =>
      children({
        state: { value: "" },
        handleChange: () => undefined,
      })
    const component = {
      _tag: "plugin",
      field: "document",
      label: "Select document",
      description: "Choose a Drive file",
      readonly: true,
      pluginType: GOOGLE_DRIVE_PLUGIN_TYPE,
      pluginData: {
        appId: "drive-app",
        clientId: "drive-client",
        developerKey: "drive-developer-key",
        generatePdf: { documentStore: "/journey-pdfs" },
      },
    } satisfies FrontendPluginField

    const fieldElement = registration!.renderer({ AppField }, component, true, {
      todoId: "todo-1",
      stepPath: "/request-eotc-permission/Select students",
    })
    const suspenseElement = fieldElement.props.children({
      state: { value: "" },
      handleChange: () => undefined,
    })
    const graphqlConsumerElement = suspenseElement.props.children
    const pickerElement = graphqlConsumerElement.props.children({
      request: async () => {
        throw new Error("GraphQL should not run while rendering")
      },
    })

    expect(fieldElement.props.name).toBe("document")
    expect(pickerElement.props).toMatchObject({
      appId: "drive-app",
      autoFocus: true,
      clientId: "drive-client",
      developerKey: "drive-developer-key",
      deleteFile: expect.any(Function),
      description: "Choose a Drive file",
      generatePdf: { documentStore: "/journey-pdfs" },
      label: "Select document",
      readOnly: true,
      requestDownloadUrl: expect.any(Function),
      requestUploadUrl: expect.any(Function),
      stepPath: "/request-eotc-permission/Select students",
    })
    expect(pickerElement.props).not.toHaveProperty("hint")
  })

  it("hints GIS with the signed-in session email", () => {
    let registration: FormRendererRegistration | undefined
    organisationFrontendPlugin.activate(
      createHost((renderer) => {
        registration = renderer
        return () => {}
      }, "teacher@example.com"),
    )

    const AppField = ({
      children,
    }: {
      children: (field: {
        readonly state: { readonly value: string }
        readonly handleChange: (value: string) => void
      }) => React.JSX.Element
    }) =>
      children({
        state: { value: "" },
        handleChange: () => undefined,
      })
    const component = {
      _tag: "plugin",
      field: "document",
      label: "Select document",
      pluginType: GOOGLE_DRIVE_PLUGIN_TYPE,
      pluginData: {
        appId: "drive-app",
        clientId: "drive-client",
        developerKey: "drive-developer-key",
      },
    } satisfies FrontendPluginField

    const fieldElement = registration!.renderer({ AppField }, component, false)
    const suspenseElement = fieldElement.props.children({
      state: { value: "" },
      handleChange: () => undefined,
    })
    const graphqlConsumerElement = suspenseElement.props.children
    const sessionConsumerElement = graphqlConsumerElement.props.children({
      request: async () => {
        throw new Error("GraphQL should not run while rendering")
      },
    })
    const pickerElement = sessionConsumerElement.props.children({
      email: "teacher@example.com",
    })

    expect(pickerElement.props.hint).toBe("teacher@example.com")
  })

  it("registers external scripts, picker data, and logout cleanup", () => {
    clearPickerEnv()
    process.env["GOOGLE_DRIVE_PICKER_CLIENT_ID"] = "drive-client"
    process.env["GOOGLE_DRIVE_PICKER_APP_ID"] = "drive-app"
    process.env["GOOGLE_DRIVE_PICKER_DEVELOPER_KEY"] = "drive-developer-key"
    registerGoogleDriveWalkerPlugin()

    const plugin = getMatchingPlugin({
      [FormGoogleDriveInput]: true,
      [FormGoogleDriveGeneratePdf]: {
        documentStore: "/journey-pdfs",
      },
    })

    expect(plugin!.type).toBe(GOOGLE_DRIVE_PLUGIN_TYPE)
    expect(
      plugin!.extractData?.({
        [FormGoogleDriveGeneratePdf]: {
          documentStore: "/journey-pdfs",
        },
      }),
    ).toEqual({
      appId: "drive-app",
      clientId: "drive-client",
      developerKey: "drive-developer-key",
      generatePdf: { documentStore: "/journey-pdfs" },
    })
    expect(plugin!.scripts).toEqual([
      {
        id: "google-identity-services",
        src: "https://accounts.google.com/gsi/client",
        async: true,
      },
      {
        id: "google-api-loader",
        src: "https://apis.google.com/js/api.js",
        async: true,
      },
    ])
    expect(() => cleanupAllPlugins()).not.toThrow()
  })

  it("bundles for browsers without server-heavy modules", async () => {
    const result = await Bun.build({
      entrypoints: [`${import.meta.dir}/register-client.tsx`],
      target: "browser",
      metafile: true,
    })

    expect(result.success).toBe(true)
    if (!result.metafile) {
      throw new Error("Expected browser bundle metadata")
    }
    const inputs = Object.keys(result.metafile.inputs)
    expect(
      inputs.some((input) => input.includes("external-credential-handoff")),
    ).toBe(false)
    expect(
      inputs.filter((input) => forbiddenBrowserModule.test(input)),
    ).toEqual([])
  })
})
