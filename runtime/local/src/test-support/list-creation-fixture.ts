import { SqlClient } from "@effect/sql"
import { Effect, Schema } from "effect"
import {
  EmailField,
  FormDateInput,
  FormDefault,
  TextField,
} from "@pf/form-schema"
import {
  List,
  ListCreateError,
  ListUpdateValidationError,
  type Organisation,
  type Role,
} from "@pf/process"

const fields = {
  name: TextField({ label: "Name" }).pipe(Schema.minLength(1)),
  email: EmailField({ label: "Email" }),
  date: Schema.String.pipe(
    Schema.pattern(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/),
  ).annotations({ title: "Date", [FormDateInput]: true }),
  category: Schema.Literal("Member", "Guest").annotations({
    title: "Category",
    [FormDefault]: "Member",
  }),
}
const row = Schema.Struct({
  id: Schema.String,
  ...fields,
  summary: Schema.String,
})

// Installed only in a disposable demo by the List acceptance runner. Real SQLite
// persistence deliberately outlives page reloads and GraphQL server restarts.
export function addListCreationFixture(org: Organisation, role: Role): void {
  const ready = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`CREATE TABLE IF NOT EXISTS list_creation_fixture (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, date TEXT NOT NULL, category TEXT NOT NULL, summary TEXT NOT NULL)`
    return sql
  })
  new List(org, "contacts", {
    name: "Contacts",
    detailName: "Contact",
    roles: [role],
    output: row.fields,
    query: ({ page, limit }) =>
      Effect.gen(function* () {
        const sql = yield* ready
        const items =
          yield* sql`SELECT * FROM list_creation_fixture ORDER BY name LIMIT ${limit} OFFSET ${(page - 1) * limit}`
        const counts = yield* sql<{
          count: number
        }>`SELECT count(*) AS count FROM list_creation_fixture`
        return {
          items: yield* Schema.decodeUnknown(Schema.Array(row))(items),
          totalCount: counts[0]?.count ?? 0,
        }
      }).pipe(Effect.orDie),
    form: () => ({
      ...fields,
      id: TextField({ label: "ID", readOnly: true }),
      summary: TextField({ label: "Summary", readOnly: true }),
    }),
    itemQuery: (id) =>
      Effect.gen(function* () {
        const sql = yield* ready
        const rows =
          yield* sql`SELECT * FROM list_creation_fixture WHERE id = ${id}`
        return rows[0] ? yield* Schema.decodeUnknown(row)(rows[0]) : null
      }).pipe(Effect.orDie),
    create: {
      form: () => ({
        ...fields,
        summary: TextField({ label: "Summary", readOnly: true }),
      }),
      submit: (input) =>
        Effect.gen(function* () {
          const sql = yield* ready
          const id = crypto.randomUUID()
          yield* sql`INSERT INTO list_creation_fixture (id, name, email, date, category, summary) VALUES (${id}, ${input.name}, ${input.email}, ${input.date}, ${input.category}, ${`${input.name} — ${input.category}`})`
          return id
        }).pipe(
          Effect.mapError(
            () =>
              new ListCreateError({
                field: "email",
                message: "A contact with that email already exists.",
              }),
          ),
        ),
    },
    update: (id, input) =>
      Effect.gen(function* () {
        const sql = yield* ready
        yield* sql`UPDATE list_creation_fixture SET name = ${input.name}, email = ${input.email}, date = ${input.date}, category = ${input.category}, summary = ${`${input.name} — ${input.category}`} WHERE id = ${id}`
        const rows =
          yield* sql`SELECT * FROM list_creation_fixture WHERE id = ${id}`
        return rows[0] ? yield* Schema.decodeUnknown(row)(rows[0]) : null
      }).pipe(
        Effect.mapError(
          () =>
            new ListUpdateValidationError({
              field: "email",
              message: "Could not save contact.",
            }),
        ),
      ),
  })
}
