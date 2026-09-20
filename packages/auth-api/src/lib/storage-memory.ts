/**
 * Memory-based storage service for OpenAuth
 *
 * This is the simplest implementation, using in-memory storage.
 * Suitable for development and testing.
 * Data is lost when the server restarts.
 *
 * Re-exports MemoryStorageServiceLive from @pf/openauth for
 * backward compatibility.
 */
/**
 * @deprecated Use MemoryStorageServiceLive from @pf/openauth directly
 */
export {
  MemoryStorageServiceLive,
  MemoryStorageServiceLive as OpenAuthMemoryStorageServiceLive,
} from "@pf/openauth"
