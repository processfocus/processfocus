import { loadDrivePickerElement } from "./drive-picker-element-loader"
import { describe, expect, it, mock } from "bun:test"

describe("loadDrivePickerElement", () => {
  it("marks the picker element as loaded after a successful import", async () => {
    const onLoaded = mock(() => undefined)
    const onError = mock(() => undefined)

    await loadDrivePickerElement(onLoaded, onError, () => Promise.resolve({}))

    expect(onLoaded).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
  })

  it("reports the existing message after a failed import", async () => {
    const onLoaded = mock(() => undefined)
    const onError = mock(() => undefined)

    await loadDrivePickerElement(onLoaded, onError, () =>
      Promise.reject(new Error("import failed")),
    )

    expect(onLoaded).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(
      "Failed to load Google Drive picker component",
    )
  })
})
