# @pf/form

Generates a TanStack Form from an Effect Schema definition.

## What This Package Owns

- Runtime rendering of dynamic form components from a precomputed client representation
- TanStack Form wiring (validation timing, submit lifecycle, error/focus behavior)
- Session-level draft persistence via localStorage (`draftId`)

This package intentionally stays generic. Domain-specific behavior (submission side effects, navigation, business rules) is supplied by the caller.

## Custom Fields

Use plugin fields for UI that is specific to an org, process, provider, or product area.

- Define custom field constructors and annotations in the owning package, not in `@pf/form`.
- Use `@pf/form-client-representation` walker plugins when custom annotations need to become `PluginField` nodes.
- Register browser renderers with `registerRendererPlugin` from the app/plugin loader before forms render.
- Set `MetricBreakdown.rendererPluginType` for metric display fields; the type stays optional only so manifests can report a missing renderer instead of crashing.
- Keep custom renderer data JSON-serializable because it flows through the client representation.
- Leave `@pf/form` responsible only for generic field rendering and plugin dispatch.

## Integration Contract

`dynamicForm` is configured via props and expects:

- `handleSubmit(values)` returning `Promise<FieldError[] | undefined>`
- `renderActions(context)` to render submit/cancel/draft controls
- `stepPath` when the form contains `Lookup` or `File` fields

Use `FieldError` with `field: ""` for form-level errors (banner), otherwise set `field` to the field path for inline field errors.

## Form UX Guidelines

Based on [Vercel Web Interface Guidelines](https://github.com/vercel-labs/web-interface-guidelines).

### Submit Button

- Submit button stays **enabled** until request starts
- Disable only during `isSubmitting`; show spinner text ("...")
- Never disable based on client-side validation state

### Error Display

- Errors shown **inline** next to each field
- Before first submit: only show errors on fields the user has actively edited
- After first submit: show all validation errors on all invalid fields
- On subsequent edits: errors clear in real-time as user fixes them
- Form-level errors (not tied to a specific field) shown in a banner above the action buttons

### Focus Management

- On submit with validation errors: focus moves to the **first** field with an error
- Field is scrolled into view with smooth scrolling
- Works for both client-side validation failures and server-returned field errors

### Validation Timing

- **Before first submit**: validate on blur (if any field is dirty); re-validate on change only if field already has errors
- **After first submit**: always validate on blur and change
- **On submit**: always validate all fields

### `FormActionsContext`

The `renderActions` callback receives a `FormActionsContext` with:
- `formState.isSubmitting` — use to disable submit button and show spinner
- `formState.isPristine` — use for "unsaved changes" warnings
- `formState.values` — current form values (for draft saving etc.)
- `clearLocalStorage()` — clears session-level draft from localStorage

## Notes

- For steps with no input fields, `dynamicForm` renders a simple submit-only form wrapper.
- Validation is driven by JSON Schema through the AJV Standard Schema adapter.
- The renderer supports advanced field types including list fields and plugin fields.
