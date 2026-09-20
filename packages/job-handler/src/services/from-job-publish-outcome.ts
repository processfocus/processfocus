/**
 * Result of attempting to publish a change event from a job handler.
 *
 * - `"published"`: document found and the event was published
 * - `"skipped-not-found"`: document missing (e.g. flow-execution rolled back);
 *   this is an expected race, not a failure
 */
export type FromJobPublishOutcome = "published" | "skipped-not-found"
