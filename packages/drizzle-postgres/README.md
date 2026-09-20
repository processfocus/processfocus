# About

Drizzle schema for Postgres.

# Known Issues

## View ordering in migrations

Drizzle-kit generates views in alphabetical order, not respecting dependencies.
If a view depends on another view, the migration may fail because the dependent
view is created before its dependency.

**Workaround**: After running `npx nx run @pf/drizzle-postgres:generate`, check
if any views depend on other views and manually reorder the SQL statements.

See: https://github.com/drizzle-team/drizzle-orm/issues/4076
