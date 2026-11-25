# @pf/shadcn-components

Shared shadcn-based controls integrated with TanStack Form. These are the field
building blocks used by [`@pf/form`](../form/README.md), alongside reusable UI
primitives.

## Read-only date and time text

Use `DateTimeDisplay` for displayed dates and timestamps across application UI.
Timestamps let the reader switch between relative, local, and UTC views, with
an optional event timezone. Calendar dates retain their date without timezone
conversion.

Provide `DateTimeDisplayProvider` around the surface with one initial reference
time. Server Components can import the focused
`@pf/shadcn-components/date-time-display` entry point.

See the [component props](./src/lib/date-time-display.tsx) for integration and
[the architectural decision](../../docs/adr/0036-read-only-dates-use-a-shared-display.md)
for the display conventions.

## Enforcement

`bun run lint:date-time-display` checks for alternative date-text formatters.
Inputs, serialization, logs, and exports have separate formatting needs;
approved exceptions are recorded in
[`tools/date-time-display-exceptions.json`](../../tools/date-time-display-exceptions.json).
