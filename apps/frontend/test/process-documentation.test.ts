import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { inlineRelativeImages } from "../app/(protected)/processes/workflow/[...processPath]/process-documentation"

describe("inlineRelativeImages", () => {
  let tempDir: string | undefined

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { force: true, recursive: true })
      tempDir = undefined
    }
  })

  test("keeps the original source when a relative image is missing", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "process-documentation-"))
    const docsDir = join(tempDir, "docs")
    mkdirSync(docsDir)

    await expect(
      inlineRelativeImages("![Missing](images/missing.png)", docsDir, tempDir),
    ).resolves.toBe("![Missing](images/missing.png)")
  })

  test("inlines existing relative images", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "process-documentation-"))
    const docsDir = join(tempDir, "docs")
    const imageDir = join(docsDir, "images")
    mkdirSync(imageDir, { recursive: true })
    writeFileSync(join(imageDir, "pixel.png"), "png")

    await expect(
      inlineRelativeImages("![Pixel](images/pixel.png)", docsDir, tempDir),
    ).resolves.toBe("![Pixel](data:image/png;base64,cG5n)")
  })

  test("preserves image titles when inlining relative images", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "process-documentation-"))
    const docsDir = join(tempDir, "docs")
    const imageDir = join(docsDir, "images")
    mkdirSync(imageDir, { recursive: true })
    writeFileSync(join(imageDir, "pixel.png"), "png")

    await expect(
      inlineRelativeImages(
        '![Pixel](images/pixel.png "A caption")',
        docsDir,
        tempDir,
      ),
    ).resolves.toBe('![Pixel](data:image/png;base64,cG5n "A caption")')
  })
})
