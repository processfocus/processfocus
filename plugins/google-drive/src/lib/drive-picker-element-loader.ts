const LOAD_ERROR_MESSAGE = "Failed to load Google Drive picker component"

type DrivePickerElementImport = () => Promise<unknown>

const importDrivePickerElement: DrivePickerElementImport = () =>
  import("@googleworkspace/drive-picker-element")

export const loadDrivePickerElement = (
  onLoaded: () => void,
  onError: (message: string) => void,
  importElement: DrivePickerElementImport = importDrivePickerElement,
): Promise<void> =>
  importElement().then(onLoaded, () => onError(LOAD_ERROR_MESSAGE))
