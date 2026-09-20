interface OpenStoredGoogleDrivePdfInput {
  readonly stepPath: string
  readonly documentStore: string
  readonly fileId: string
  readonly requestDownloadUrl: (input: {
    readonly stepPath: string
    readonly documentStore: string
    readonly fileId: string
  }) => Promise<{ readonly downloadUrl: string }>
  readonly openUrl: (url: string) => void
}

export const openStoredGoogleDrivePdf = async ({
  stepPath,
  documentStore,
  fileId,
  requestDownloadUrl,
  openUrl,
}: OpenStoredGoogleDrivePdfInput): Promise<void> => {
  const { downloadUrl } = await requestDownloadUrl({
    stepPath,
    documentStore,
    fileId,
  })
  openUrl(downloadUrl)
}
