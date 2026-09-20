/**
 * Re-export StorageService from OpenAuth for backward compatibility.
 *
 * This module previously defined OpenAuthStorageService as a wrapper around
 * StorageAdapter. Now that StorageService is first-class in OpenAuth, we
 * export it here for consumers that still import from this location.
 */
/**
 * @deprecated Use StorageService directly from @pf/openauth
 */
export {
  StorageService,
  StorageService as OpenAuthStorageService,
} from "@pf/openauth"
