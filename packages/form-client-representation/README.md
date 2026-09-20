# About

Transform an Effect Schema to a form represented as pure JSON.

We need an client side representation of a schema and form for the following reasons:
1. A Tanstack form must be created on the client side due to its reactivity.
2. We cannot send an Effect schema from backend to frontend due to
   potentially complex logic embedded in it.
3. So the Effect Schema itself cannot be used client side.

This package is the answer to these problems:
1. It creates a pure JSON representation of a form which can be used client side.
2. The client builds the Tanstack Form using this representation.
3. It uses JSON schema derived from the Effect Schema for fast client side validation.
4. It regularly calls the server for the full Effect Schema validation.

## Architecture

The main function provided by this package is
`asClientRepresentation`. It returns form components as algebraic data
types (ADTs).

## Examples

### Basic Usage

The `asClientRepresentation` function converts an Effect `Schema.Struct` into a JSON representation suitable for client-side form rendering. Each field is mapped to a form component type based on its schema type: strings become text fields, numbers become number fields, and booleans become checkboxes.

```typescript
import { Effect, Schema as ES } from "effect"
import { asClientRepresentation } from "@pf/form-client-representation"

const schema = ES.Struct({
  username: ES.String,
  age: ES.Number,
  isActive: ES.Boolean,
})

const representation = Effect.runSync(asClientRepresentation(schema))
// Result:
// {
//   username: { field: "username", _tag: "text", label: "Username" },
//   age: { field: "age", _tag: "number", label: "Age" },
//   isActive: { field: "isActive", _tag: "boolean", label: "IsActive" }
// }
```

### Transformations

Effect schemas often use transformations like `NumberFromString` to parse user input. The client representation uses the **input side** of transformations, since that's what the user actually types. The transformation happens server-side during validation.

```typescript
const schema = ES.Struct({
  age: ES.NumberFromString,
})

const representation = Effect.runSync(asClientRepresentation(schema))
// Result:
// {
//   age: { field: "age", _tag: "text", label: "Age" }
// }
// Note: _tag is "text" (input side), not "number" (output side)
```

### Custom Labels and Descriptions

Use `FormLabel` and `FormDescription` annotations to customize how fields appear in the form. These annotations are extracted and included in the client representation, allowing for user-friendly field labels and helpful descriptions.

```typescript
import { FormLabel, FormDescription } from "@pf/form-client-representation"

const schema = ES.Struct({
  username: ES.String
    .annotations({
      [FormLabel]: "User Name",
      [FormDescription]: "Choose a unique username",
    }),
  age: ES.NumberFromString
    .annotations({
      [FormLabel]: "Age (years)",
    }),
})

const representation = Effect.runSync(asClientRepresentation(schema))
// Result:
// {
//   username: {
//     field: "username",
//     _tag: "text",
//     label: "User Name",
//     description: "Choose a unique username"
//   },
//   age: {
//     field: "age",
//     _tag: "text",
//     label: "Age (years)"
//   }
// }
```

### Nested Structures

Nested structs become FieldSets that group related fields together. The parent field name is included in the path of nested fields, creating a hierarchical structure that matches the schema shape.

```typescript
const schema = ES.Struct({
  username: ES.String,
  address: ES.Struct({
    street: ES.String,
    city: ES.String,
  }),
})

const representation = Effect.runSync(asClientRepresentation(schema))
// Result:
// {
//   username: { field: "username", _tag: "text", label: "Username" },
//   address: {
//     _tag: "fieldset",
//     label: "Address",
//     children: {
//       street: { field: "address.street", _tag: "text", label: "Street" },
//       city: { field: "address.city", _tag: "text", label: "City" }
//     }
//   }
// }
```

### Flattened FieldSets with Wrapper

The `Wrapper` function from `@pf/form-schema` creates a FieldSet for visual grouping without adding to the field path. This is useful for organizing forms into sections or tabs where the grouping is purely presentational.

```typescript
import { Wrapper } from "@pf/form-schema"

const schema = ES.Struct({
  username: ES.String,
  address: Wrapper({
    street: ES.String,
    city: ES.String,
  }),
})

const representation = await Effect.runPromise(asClientRepresentation(schema))
// Result:
// {
//   username: { field: "username", _tag: "text", label: "Username" },
//   address: {
//     _tag: "fieldset",
//     label: "Address",
//     children: {
//       street: { field: "street", _tag: "text", label: "Street" },
//       city: { field: "city", _tag: "text", label: "City" }
//     }
//   }
// }
// Note: street and city fields don't have "address." prefix
```
