import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { compile } from "tailwindcss"
import { prepareDashboardStyles } from "./dashboard-styles"
import { expect, test } from "bun:test"

test("compiles ignored consumer sources while keeping public and protected utility sets separate", async () => {
  const root = mkdtempSync(join(tmpdir(), "dashboard-styles-"))
  try {
    writeFileSync(join(root, ".gitignore"), "*\n")
    mkdirSync(join(root, "public"))
    mkdirSync(join(root, "protected"))
    writeFileSync(
      join(root, "public/page.tsx"),
      '<p className="sr-only">Public</p>',
    )
    writeFileSync(
      join(root, "protected/modal.tsx"),
      '<div className="fixed empty:hidden" />',
    )
    writeFileSync(
      join(root, "public.css"),
      '@tailwind utilities;\n@source "./public/**/*.{ts,tsx}";',
    )
    writeFileSync(
      join(root, "protected.css"),
      '@tailwind utilities;\n@source "./protected";',
    )
    prepareDashboardStyles(root)
    const publicCss = (
      await compile(readFileSync(join(root, "public.css"), "utf8"))
    ).build([])
    const protectedCss = (
      await compile(readFileSync(join(root, "protected.css"), "utf8"))
    ).build([])
    expect(publicCss).toContain(".sr-only")
    expect(publicCss).not.toContain(".fixed")
    expect(protectedCss).toContain(".fixed")
    expect(protectedCss).toContain(".empty\\:hidden")
    expect(protectedCss).not.toContain(".sr-only")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
