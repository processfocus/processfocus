# xplain2drizzle

Convert Xplain DDL files to Drizzle ORM schemas for PostgreSQL.

## Usage

```bash
bun xplain2drizzle --database postgres <input.ddl> <output.ts>
```

**Example:**
```bash
bun xplain2drizzle --database postgres schema.ddl src/db/schema.ts
```

## Features

### Supported (Phase 1)
- All Xplain data types (A, B, C, D, I, J, R, T, U).
  Note that the json data type is always a Record<string, unknown> type
- Optional/required attributes
- Type references (foreign keys)
- Literal defaults
- Indexes (unique and non-unique)
- Multi-word identifiers
- Derived attributes (e.g., `unit_price` from base `price`)

### Type Mappings

#### PostgreSQL
| Xplain | Drizzle |
|--------|---------|
| `A{n}` | `varchar(length: n)` |
| `B` | `boolean` |
| `C{n}` | `citext` (custom type, requires extension) |
| `D` | `timestamp(withTimezone: false)` |
| `I{n}` | `integer` |
| `J` | `jsonb` |
| `R{n,m}` | `numeric(precision: n+m, scale: m)` |
| `T` | `text` |
| `U` | `varchar(length: 255)` |

#### SQLite
| Xplain | Drizzle |
|--------|---------|
| `A{n}` | `text(length: n)` |
| `B` | `integer(mode: "boolean")` |
| `C{n}` | `text collate nocase` (custom type, ASCII-only) |
| `D` | `integer(mode: "timestamp")` |
| `I{n}` | `integer` |
| `J` | `text(mode: "json")` |
| `R{n,m}` | `real` |
| `T` | `text` |
| `U` | `text(length: 255)` |

### Special Notes

**Case-Insensitive Text (C type):**
- PostgreSQL: Requires `CREATE EXTENSION IF NOT EXISTS citext` before running migrations
- SQLite: Uses `COLLATE NOCASE` which is ASCII-only (doesn't handle Unicode case folding)
- Length constraint is enforced at database level using CHECK constraints

### Naming Conventions
- Database columns: `snake_case`
- TypeScript exports: `camelCase`
- Every type gets an implicit `id: uuid` primary key

## Example

**Input (schema.ddl):**
```
base name (A64).
base email (A255).

type customer = name, email.
index customer its email_idx = email.
```

**Output (schema.ts):**
```typescript
import { index, pgTable, uuid, varchar } from "drizzle-orm/pg-core"

export const customer = pgTable("customer", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 64 }).notNull(),
  email: varchar("email", { length: 255 }).notNull(),
}, (table) => ({
  emailIdxIdx: index("email_idx_idx").on(table.email),
}))
```

## Limitations

**Not yet supported:**
- Complex default expressions (e.g., `system_date`, arithmetic)
- Init values
- Assert (generated columns)
- Conditionals in expressions
