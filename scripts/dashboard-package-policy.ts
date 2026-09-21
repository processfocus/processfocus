/** Public packages carry Dashboard source, never a Next deployment or its keys. */
export const assertDashboardPackageFile = (
  file: string,
  content?: string,
): void => {
  if (
    /(^|\/)(?:\.next|\.open-next|node_modules)(?:\/|$)/.test(file) ||
    /(?:^|\/)(?:BUILD_ID|server-reference-manifest\.(?:json|js)|prerender-manifest\.json|routes-manifest\.json)$/.test(
      file,
    ) ||
    file.startsWith("dist/dashboard/")
  )
    throw new Error(
      `${file} contains compiled Dashboard output or installed dependencies`,
    )
  if (
    content &&
    /["']?(?:encryptionKey|previewModeId|previewModeEncryptionKey|previewModeSigningKey)["']?\s*:\s*["'][^"'\s]+["']/.test(
      content,
    )
  ) {
    throw new Error(`${file} contains generated Next.js secret material`)
  }
}
