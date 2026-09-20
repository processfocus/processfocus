import { openStoredGoogleDrivePdf } from "./google-drive-download"
import { describe, expect, it } from "bun:test"

describe("stored Google Drive PDF download", () => {
  it("opens a just-in-time download URL without adding it to stored state", async () => {
    const requests: Array<{
      readonly stepPath: string
      readonly documentStore: string
      readonly fileId: string
    }> = []
    const openedUrls: string[] = []

    await openStoredGoogleDrivePdf({
      stepPath: "/duke-of-ed-tramp/Approval",
      documentStore: "/google-generate-pdfs",
      fileId: "file-trip-pdf",
      requestDownloadUrl: (input) => {
        requests.push(input)
        return Promise.resolve({
          downloadUrl: "https://files.example.com/signed-trip-pdf",
        })
      },
      openUrl: (url) => openedUrls.push(url),
    })

    expect(requests).toEqual([
      {
        stepPath: "/duke-of-ed-tramp/Approval",
        documentStore: "/google-generate-pdfs",
        fileId: "file-trip-pdf",
      },
    ])
    expect(openedUrls).toEqual(["https://files.example.com/signed-trip-pdf"])
  })
})
