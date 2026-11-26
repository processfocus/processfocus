# @pf/form-schema

Effect Schema field constructors and presentation annotations shared by form
authors, browser rendering, and server validation.

## Presentation and data

Forms describe both what people see and what they submit. `Wrapper` groups
fields visually while keeping their submitted values flat. Text, dividers,
images, and other structural elements add presentation without adding process
state. Ordinary nested structs retain their nesting.

[`@pf/form-submission-schema`](../form-submission-schema/README.md) derives the
data-only schema; [`@pf/form`](../form/README.md) renders the form.

Process Forms can defer defaults and presentation until execution data is
available while keeping their value schema stable. See
[constructor Form authoring](../../docs/business-process-modelling/constructor-form-authoring.md).

## Date and time fields

Use `DateField` for a date without a time. Use
`LocalDateTimeField({ label: "Starts at", required: true })` for a calendar date
and time entered together. It submits `YYYY-MM-DD HH:mm` (optionally with
seconds), with no timezone offset. Tell users which timezone to enter and
interpret the value in that zone on the server. Wrap the field in
`Schema.optional(...)` and omit `required` when it may be left blank.

## Authenticated server lookups

Lookup fields select IDs; suggestion fields allow free text. For server search,
bind an authorized datasource and an independent selected-ID resolver in server
code. Browser definitions contain the field declaration, not backend queries.

For small datasets, explicit local mode loads all eligible choices within an
authored bound. See [lookup fields](../form/lookup-design.md) for the tradeoffs.

The [source exports](./src/index.ts) are the reference for available field
constructors and annotations.
