import { Construct, type IConstruct } from "constructs"
import { GoogleDrive } from "./google-drive"
import { describe, expect, it } from "bun:test"

class RootConstruct extends Construct {
  constructor() {
    super(undefined as unknown as IConstruct, "root")
  }
}

describe("GoogleDrive", () => {
  it("declares organisation-owned browser registration and preparation", () => {
    const googleDrive = new GoogleDrive(new RootConstruct(), "google-drive")

    expect(googleDrive.buildFrontendClientPluginManifest()).toEqual({
      module: "@processfocus/plugin-google-drive/register-client",
      type: "google-drive",
      config: null,
    })
    expect(googleDrive.buildBrowserPluginArtifact()).toEqual({
      identity: "google-drive",
      category: "formComponents",
      hostInterfaceVersion: 1,
      entrypoint: "@processfocus/plugin-google-drive/browser",
      preparation: {
        kind: "stylesheet",
        entrypoint: "@processfocus/plugin-google-drive/styles.css",
      },
    })
  })
})
