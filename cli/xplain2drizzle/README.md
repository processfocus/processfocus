# xplain2drizzle

Converts Xplain DDL into Drizzle ORM schemas for PostgreSQL or SQLite.

## Usage

From the workspace root:

```bash
bun cli/xplain2drizzle/src/main.ts schema.ddl src/db/schema.ts --database postgres
bun cli/xplain2drizzle/src/main.ts schema.ddl src/db/schema.ts --database sqlite --prefix pf_
```

The generator writes the schema to the supplied path and `triggers.sql` beside
it. Without an output path, it displays the schema in the terminal.

Generated tables include the platform's audit and soft-delete fields. The
optional prefix namespaces SQL objects when sharing a database.

For case-insensitive text, PostgreSQL needs the `citext` extension; SQLite uses
ASCII-only `NOCASE` collation. Review the generated schema and trigger SQL as
part of preparing database migrations.
