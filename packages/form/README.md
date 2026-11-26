# @pf/form

Shared React form renderer built on TanStack Form and executable Effect schemas.
It brings field rendering, validation, submission feedback, and optional draft
persistence to Process Focus form surfaces.

The surrounding application supplies data access, submission behavior, and
navigation. Organisation-specific fields can register renderer plugins.

## Related packages

- [`@pf/form-schema`](../form-schema/README.md) describes fields and presentation.
- [`@pf/form-submission-schema`](../form-submission-schema/README.md) derives the
  submitted data shape and supports shared rule validation.
- [`@pf/shadcn-components`](../shadcn-components/README.md) supplies field controls.

See [lookup fields](./lookup-design.md) for choosing local or server search.
The renderer entry point is
[`EffectSchemaForm`](./src/lib/effect-schema-form.tsx).

## Date inputs

Date fields support typing and calendar selection. A calendar date is submitted
at UTC midnight, without shifting it to the viewer's timezone. Invalid input
must be corrected before submission; requiredness comes from the shared schema.
