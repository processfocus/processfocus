# @pf/form-submission-schema

Connects a form's presentation schema to the data it accepts.

Submission schemas flatten visual wrappers and exclude structural and read-only
fields while preserving ordinary nested data. This keeps layout changes from
altering the stored process state. Ambiguous field names are rejected.

The package also supplies form defaults and shared Form Rule evaluation.
Defaults initialize controls; they are not proof that a submission is valid.

Use [`@pf/form-schema`](../form-schema/README.md) to declare fields and
[`@pf/form`](../form/README.md) to render them. See the
[exports](./src/index.ts) for Effect and synchronous integration helpers.
