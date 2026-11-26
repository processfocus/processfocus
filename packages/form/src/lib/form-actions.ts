export interface FieldError {
  field: string
  message: string
}

/**
 * Context passed to the renderActions callback.
 * Provides form state and utilities for rendering custom action buttons.
 *
 * Note: Submit button should only be disabled during `isSubmitting`.
 * Validation errors are shown inline after the user presses submit,
 * per Web Interface Guidelines: "Submit button stays enabled until
 * request starts; spinner during request."
 */
export interface FormActionsContext {
  /** Current form state */
  readonly formState: {
    readonly values: Record<string, unknown>
    readonly isSubmitting: boolean
    /** An actual submission is in progress, not just prefill. */
    readonly isSubmittingRequest: boolean
    readonly isPristine: boolean
  }
  /** Clear the session-level localStorage for this form */
  readonly clearLocalStorage: () => void
}
