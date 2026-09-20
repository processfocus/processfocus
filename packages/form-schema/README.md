# About

Provide ability to create Effect Schema's that contain form structural
elements. Use the form-submission-schema package to remove those
elements, and derive the actual submission structure.

## Architecture: Structural Elements Do Not Affect State

Form structural elements — `Wrapper`, `Divider`, `TextBlock`, `Image`,
`Link`, and any `StructuralOnly`-annotated field — are **purely
presentational**. They affect form rendering and organisation only.

They do **not** contribute to:

- the GraphQL input type (flattened/removed by `submissionSchema`),
- the persisted process state shape,
- downstream step state types (`state.firstName`, never
  `state.contactDetails.firstName`).

`Wrapper` groups fields for UI layout (tabs, sections) while the
submission schema flattens them into the parent. Changing, adding, or
removing a `Wrapper` therefore has zero effect on the API contract or
stored data.

## Features

- **Wrapper** - Group fields semantically without nesting in the resulting type
- **Structural-only elements** - UI-only elements (dividers, text, images) excluded from submission
- **Recursive flattening** - Supports nested Wrappers at any depth
- **Collision detection** - Prevents field name conflicts during flattening
- **Type-safe** - Full TypeScript type inference with Effect Schema

## Installation

```bash
bun add @pf/form-schema
```

## Usage

### Deferred presentation and defaults

`Form` from `@pf/process` (public SDK: `processfocus`) supplies
`value`, `content`, and `query` helpers in its declaration callback. Field
options accept opaque `DeferredValue<T>` descriptors only for presentation,
defaults and query bindings. Requiredness, read-only classification, options
and schemas remain static. Descriptors must be resolved by their owning Form;
they are never cast to strings/functions or serialized to clients.

```ts
new Form(flow, "Review", {
  role,
  form: ({ value }) => ({
    name: TextField({ readOnly: true, default: value((state) => state.name) }),
    count: NumberFieldFrom(Schema.NumberFromString, {
      default: value((state) => String(state.count)),
    }),
  }),
})
```

Defaults for transformations use their encoded input type (a string for
`NumberFromString` or a date field), not the decoded output. Optional presentation
fallbacks can be supplied as `value(resolve, fallback)`. Shared helpers can
accept `FormValue<T>` to support either static or deferred values, keeping their
schemas and columns in one place. See
[constructor Form authoring](../../docs/business-process-modelling/constructor-form-authoring.md).

### Basic Example

Use `Wrapper` to group related fields semantically in your UI, then use `submissionSchema` to flatten them for API submission:

```typescript
import { Schema as ES } from "effect"
import { Wrapper, submissionSchema } from "@pf/form-schema"

// Define a form schema with semantic grouping
const UserForm = ES.Struct({
  username: ES.String,
  address: Wrapper({
    street: ES.String,
    town: ES.String,
  }),
  contact: Wrapper({
    email: ES.String,
    phone: ES.String,
  })
})

// Create a flattened submission schema
const UserSubmission = submissionSchema(UserForm)

// Type of UserSubmission.Type:
// {
//   username: string
//   street: string
//   town: string
//   email: string
//   phone: string
// }
```

### Use Case: UI Tabs vs API Submission

A common pattern is to organize forms into tabs for the UI, but submit a flat structure to the API:

```typescript
import { Schema as ES } from "effect"
import { Wrapper, submissionSchema } from "@pf/form-schema"

const RegistrationForm = ES.Struct({
  basicInfo: Wrapper({
    username: ES.String,
    email: ES.String,
  }),
  addressInfo: Wrapper({
    street: ES.String,
    city: ES.String,
    zipCode: ES.String,
  }),
  preferences: Wrapper({
    newsletter: ES.Boolean,
    notifications: ES.Boolean,
  })
})

// For UI rendering - use original schema with tabs
const formSchema = RegistrationForm // Has basicInfo, addressInfo, preferences

// For API submission - use flattened schema
const apiSchema = submissionSchema(RegistrationForm)
// Type: { username, email, street, city, zipCode, newsletter, notifications }
```

### Nested Wrappers

Wrappers can be nested at any depth and will be recursively flattened:

```typescript
const ComplexForm = ES.Struct({
  section1: Wrapper({
    subsection1: Wrapper({
      field1: ES.String,
      field2: ES.Number,
    }),
    subsection2: Wrapper({
      field3: ES.Boolean,
    })
  })
})

const flattened = submissionSchema(ComplexForm)
// Type: { field1: string, field2: number, field3: boolean }
```

### Preserving Nested Structs

Regular `ES.Struct` fields (without Wrapper) are preserved as nested structures:

```typescript
const MixedForm = ES.Struct({
  username: ES.String,
  address: Wrapper({
    street: ES.String,
    city: ES.String,
  }),
  metadata: ES.Struct({  // Regular struct - not flattened
    createdAt: ES.Date,
    updatedAt: ES.Date,
  })
})

const submission = submissionSchema(MixedForm)
// Type: {
//   username: string
//   street: string
//   city: string
//   metadata: { createdAt: Date, updatedAt: Date }
// }
```

### Structural-Only Elements

Structural-only elements appear in your form UI but are automatically excluded from the submission schema. These are useful for dividers, informational text, images, and other non-data UI elements.

#### Available Helpers

- `Divider` - Visual divider/separator
- `TextBlock(text: string)` - Display text or instructions
- `Image(src: string, alt?: string)` - Display an image
- `Link(url: string, text: string)` - Display a hyperlink
- `StructuralOnly` - Generic marker for custom structural elements

#### Example

```typescript
import { Schema as ES } from "effect"
import { submissionSchema, Divider, TextBlock, Image } from "@pf/form-schema"

const RegistrationForm = ES.Struct({
  header: TextBlock("Create your account"),
  username: ES.String,
  email: ES.String,
  separator: Divider,
  logo: Image("logo.png", "Company Logo"),
  password: ES.String,
})

const submission = submissionSchema(RegistrationForm)
// Type: { username: string, email: string, password: string }
// header, separator, and logo are excluded from submission

// Structural elements remain in form structure for UI rendering
// but do not appear in the submission type or validation
```

#### Custom Structural Elements

For custom structural elements, you can create your own using the same pattern:

```typescript
import { Schema as ES } from "effect"

// Custom alert box (requires creating a structuralElement helper)
const AlertBox = (message: string, severity: "info" | "warning") =>
  structuralElement("alert", { message, severity })

const form = ES.Struct({
  warning: AlertBox("Please review carefully", "warning"),
  agreement: ES.Boolean,
})
```

### Field Helpers with Labels and Descriptions

Field helpers provide a convenient way to attach labels and descriptions to form fields using annotations. These annotations can be extracted by form renderers to display labels and descriptions in the UI.

#### Available Field Helpers

- `TextField(options?)` - Creates a string field
- `TextFieldFrom(schema, options?)` - Creates a string field from a transformation schema
- `NumberField(options?)` - Creates a number field
- `NumberFieldFrom(schema, options?)` - Creates a number field from a transformation schema
- `BooleanField(options?)` - Creates a boolean field

#### Field Options

All field helpers accept an optional `FieldOptions` object:

```typescript
interface FieldOptions {
  label?: string        // Display label for the field
  description?: string  // Help text or description
}
```

#### Examples

**Basic usage with labels and descriptions:**

```typescript
import { Schema as ES } from "effect"
import { TextField, NumberField, BooleanField } from "@pf/form-schema"

const UserForm = ES.Struct({
  username: TextField({ 
    label: "Username", 
    description: "Choose a unique username" 
  }),
  age: NumberField({ 
    label: "Your age", 
    description: "Age in years" 
  }),
  acceptTerms: BooleanField({ 
    label: "Accept terms and conditions" 
  })
})
```

**Using transformation schemas:**

```typescript
import { Schema as ES } from "effect"
import { TextFieldFrom, NumberFieldFrom } from "@pf/form-schema"

const RegistrationForm = ES.Struct({
  birthDate: TextFieldFrom(ES.DateFromString, {
    label: "Birth date",
    description: "Enter your date of birth"
  }),
  age: NumberFieldFrom(ES.NumberFromString, {
    label: "Your age"
  })
})
```

**Combining with validation:**

```typescript
import { Schema as ES } from "effect"
import { TextField } from "@pf/form-schema"

const schema = ES.Struct({
  username: TextField({ label: "Username" })
    .pipe(ES.minLength(3), ES.maxLength(20)),
  email: TextField({ label: "Email address" })
    .pipe(ES.pattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/))
})
```

#### Accessing Annotations

Labels and descriptions are stored as annotations using `FormLabel` and `FormDescription` symbols:

```typescript
import { FormLabel, FormDescription } from "@pf/form-schema"

const field = TextField({ 
  label: "Street name", 
  description: "Your street address" 
})

const annotations = field.ast.annotations
const label = annotations[FormLabel]             // "Street name"
const description = annotations[FormDescription] // "Your street address"
```

Form rendering libraries can extract these annotations to display labels and help text in the UI.

## API

### `Wrapper<Fields>(fields: Fields)`

Creates a schema annotated for flattening. Use this to semantically group fields in the UI while keeping them flat in the submission type.

**Returns:** `Schema.Struct<Fields> & FlattenMarker`

### `FieldNameCollisionError`

Error thrown when field names collide during flattening.

**Properties:**
- `fieldName: string` - The colliding field name
- `wrapperField: string` - The field path in the Wrapper

### Structural-Only Element Helpers

#### `Divider`

Constant schema for visual dividers/separators.

**Type:** `Schema.Schema.Any & StructuralOnlyMarker`

**Example:**
```typescript
const form = ES.Struct({
  section1: ES.String,
  divider: Divider,
  section2: ES.String,
})
```

#### `TextBlock(text: string)`

Creates a text block for displaying instructions or information.

**Parameters:**
- `text: string` - The text content to display

**Returns:** `Schema.Schema.Any & StructuralOnlyMarker`

**Example:**
```typescript
const form = ES.Struct({
  header: TextBlock("Please fill out the form below"),
  username: ES.String,
})
```

#### `Image(src: string, alt?: string)`

Creates an image element.

**Parameters:**
- `src: string` - Image source URL
- `alt?: string` - Alternative text for accessibility

**Returns:** `Schema.Schema.Any & StructuralOnlyMarker`

**Example:**
```typescript
const form = ES.Struct({
  logo: Image("logo.png", "Company Logo"),
  username: ES.String,
})
```

#### `Link(url: string, text: string)`

Creates a hyperlink element.

**Parameters:**
- `url: string` - Link destination URL
- `text: string` - Link display text

**Returns:** `Schema.Schema.Any & StructuralOnlyMarker`

**Example:**
```typescript
const form = ES.Struct({
  terms: Link("https://example.com/terms", "Read our terms"),
  agree: ES.Boolean,
})
```

#### `StructuralOnly`

Generic structural-only marker for custom use cases.

**Type:** `Schema.Schema.Any & StructuralOnlyMarker`

**Example:**
```typescript
const form = ES.Struct({
  customElement: StructuralOnly,
  username: ES.String,
})
```

### Field Helper Functions

Field helper functions create Effect Schema fields with attached label and description annotations.

#### `TextField(options?: FieldOptions)`

Creates a string field with optional label and description.

**Parameters:**
- `options?: FieldOptions` - Optional field configuration
  - `label?: string` - Display label for the field
  - `description?: string` - Help text or description

**Returns:** `Schema.Schema<string, string, never>`

**Example:**
```typescript
const schema = ES.Struct({
  street: TextField({ 
    label: "Street name", 
    description: "Your street address" 
  })
})
```

#### `TextFieldFrom<I, R>(schema: Schema<string, I, R>, options?: FieldOptions)`

Creates a string field from a transformation schema with optional label and description.

**Parameters:**
- `schema: Schema<string, I, R>` - Transformation schema (e.g., `DateFromString`)
- `options?: FieldOptions` - Optional field configuration

**Returns:** `Schema.Schema<string, I, R>`

**Example:**
```typescript
const schema = ES.Struct({
  birthDate: TextFieldFrom(ES.DateFromString, { 
    label: "Birth date",
    description: "Enter your date of birth"
  })
})
```

#### `NumberField(options?: FieldOptions)`

Creates a number field with optional label and description.

**Parameters:**
- `options?: FieldOptions` - Optional field configuration

**Returns:** `Schema.Schema<number, number, never>`

**Example:**
```typescript
const schema = ES.Struct({
  age: NumberField({ 
    label: "Your age", 
    description: "Age in years" 
  })
})
```

#### `NumberFieldFrom<I, R>(schema: Schema<number, I, R>, options?: FieldOptions)`

Creates a number field from a transformation schema with optional label and description.

**Parameters:**
- `schema: Schema<number, I, R>` - Transformation schema (e.g., `NumberFromString`)
- `options?: FieldOptions` - Optional field configuration

**Returns:** `Schema.Schema<number, I, R>`

**Example:**
```typescript
const schema = ES.Struct({
  age: NumberFieldFrom(ES.NumberFromString, { 
    label: "Your age" 
  })
})
```

#### `BooleanField(options?: FieldOptions)`

Creates a boolean field with optional label and description.

**Parameters:**
- `options?: FieldOptions` - Optional field configuration

**Returns:** `Schema.Schema<boolean, boolean, never>`

**Example:**
```typescript
const schema = ES.Struct({
  acceptTerms: BooleanField({ 
    label: "Accept terms and conditions" 
  })
})
```

### Annotation Symbols

#### `FormLabel`

Symbol used to annotate schemas with a display label.

**Type:** `symbol`

**Value:** `Symbol.for("pf/form/annotation/Label")`

**Example:**
```typescript
import { FormLabel } from "@pf/form-schema"

const field = TextField({ label: "Username" })
const label = field.ast.annotations[FormLabel] // "Username"
```

#### `FormDescription`

Symbol used to annotate schemas with a description or help text.

**Type:** `symbol`

**Value:** `Symbol.for("pf/form/annotation/Description")`

**Example:**
```typescript
import { FormDescription } from "@pf/form-schema"

const field = TextField({ description: "Choose a unique username" })
const description = field.ast.annotations[FormDescription] 
// "Choose a unique username"
```
