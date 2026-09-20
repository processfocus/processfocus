# About

Derive the submission schema from an Effect Schema which is typed as a
form. It removes the form specific components, and returns just the
fields that should be submitted, without the form structural elements.

## Features

- **submissionSchema** - Flatten Wrapper fields to create submission-ready schemas
- **Default value generation** - Generate type-compatible default values for form fields
- **Type-safe** - Full TypeScript type inference with Effect Schema

## Installation

```bash
bun add @pf/form-submission-schema
```

## Usage

### Error Handling

`submissionSchema` returns an Effect that fails with typed tagged errors
(`FieldNameCollisionError` | `InvalidFlattenAnnotationError`). Use
`Effect.flip` / `Effect.exit` in Effect code, or `submissionSchemaSync` at
sync boundaries (rethrows the original TaggedError):

```typescript
import { Effect, Schema as ES } from "effect"
import {
  FieldNameCollisionError,
  submissionSchema,
  submissionSchemaSync,
} from "@pf/form-submission-schema"
import { Wrapper } from "@pf/form-schema"

const InvalidForm = ES.Struct({
  email: ES.String,
  contact: Wrapper({
    email: ES.String,  // Collision!
  })
})

// Effect-native
const error = Effect.runSync(Effect.flip(submissionSchema(InvalidForm)))
// FieldNameCollisionError

// Sync boundary (model construction, tests that expect throw)
try {
  submissionSchemaSync(InvalidForm)
} catch (error) {
  // FieldNameCollisionError: Field name collision: "contact...email" is already present as "email" in its parent struct
}
```

It uses "..." as email could have come from a very nested layer, and
by the time the error is detected, the original location is no longer
known.

### Default Values

Generate type-compatible default values from schema fields for form initialization:

```typescript
import { Schema as ES } from "effect"
import { getSchemaDefaults } from "@pf/form-submission-schema"

const schema = {
  username: ES.String,
  age: ES.NumberFromString,
  isActive: ES.Boolean,
  address: ES.Struct({
    street: ES.String,
    city: ES.String,
  })
}

const defaults = getSchemaDefaults(schema)
// Result:
// {
//   username: "",
//   age: "",
//   isActive: false,
//   address: { street: "", city: "" }
// }
```

The generated defaults are:
- **Strings**: empty string `""`
- **Numbers**: empty string `""` (for NumberFromString transformations)
- **Booleans**: `false`
- **Nested structs**: recursively generated defaults
- **Unknown types**: `undefined`

Note: These values are NOT validated - they're just type-compatible placeholders to prevent uncontrolled input errors in forms. The actual validation happens when the form is submitted.

## API

### `submissionSchema<Fields>(schema: Schema.Struct<Fields>)`

Flattens all Wrapper fields recursively while preserving regular nested structs.

**Returns:**
`Effect.Effect<Schema.Struct<FlattenedFields>, FieldNameCollisionError | InvalidFlattenAnnotationError>`

Failures are typed Effect failures (not thrown exceptions). Compose with
`yield*`, `Effect.flip`, or `Effect.exit`.

### `submissionSchemaSync<Fields>(schema: Schema.Struct<Fields>)`

Synchronous boundary helper for constructors and other non-Effect call sites.

**Returns:** `Schema.Struct<FlattenedFields>`

**Throws:** the original `FieldNameCollisionError` /
`InvalidFlattenAnnotationError` (not a FiberFailure wrapper)

### `FieldNameCollisionError`

Tagged error when field names collide during flattening.

**Properties:**
- `fieldName: string` - The colliding field name
- `wrapperField: string` - The field path in the Wrapper

### `getSchemaDefaults<Fields>(fields: Fields)`

Generate type-compatible default values from Effect Schema fields.

**Parameters:**
- `fields: Schema.Struct.Fields` - The schema fields to generate defaults for

**Returns:** Object with default values for each field

**Example:**
```typescript
const defaults = getSchemaDefaults({
  name: ES.String,
  age: ES.NumberFromString,
  active: ES.Boolean
})
// Returns: { name: "", age: "", active: false }
```

**Note:** Values are NOT validated - they're type-compatible placeholders. Strings and NumberFromString return `""`, booleans return `false`, nested structs return recursively generated defaults, and unknown types return `undefined`.
