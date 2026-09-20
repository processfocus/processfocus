# About

This package allows you to create business process in a type-safe manner.

# Business process flows

## Process example with branching

```typescript
const reviewStep = new Form(this, "Review", {
  role: managerRole,
  form: () => ({
    passed: ES.Boolean,
  }),
})

const passedStep = new Form(this, "Passed", {
  role: hrRole,
  form: () => ({}),
})

const failedStep = new Form(this, "Failed", {
  role: hrRole,
  form: () => ({}),
})

const flow = process.start(reviewStep)
flow.next(passedStep, (state) => state.passed).end()   // Type-safe!
flow.next(failedStep, (state) => !state.passed).end()  // Type-safe!
```

## Flow Termination

Every flow path must be explicitly terminated with `.end()`. This creates an edge to a virtual `__end__` node, allowing validation to detect incomplete flows.

```typescript
// Single path
process.start(step1).next(step2).end()

// Shorthand: .end(step) = .next(step) + .end()
process.start(step1).end(step2)

// Branching: each branch needs .end()
const flow = process.start(step1)
flow.next(approvedStep, (s) => s.approved).end()
flow.next(rejectedStep, (s) => !s.approved).end()
```

### Dangling Step Detection

Steps without an outgoing edge (missing `.end()`) are "dangling" and will cause validation errors during build/import. Use `process.validateFlows()` to get an array of dangling step paths:

```typescript
const dangling = process.validateFlows()
if (dangling.length > 0) {
  console.error("Unterminated flows:", dangling)
}
```

Common causes:
- Forgetting `.end()` on a branch
- Creating a step but never connecting it to the flow
- Using `.next()` without `.end()` on the final step

## Forms

Forms are user-facing steps that collect input. They extend `Step` with
additional capabilities for UI rendering, validation, and state-based defaults.

### Defining Form Fields

Import `Form` from `@pf/process` (`processfocus` in the public SDK).
One declaration owns the schema;
inline helpers defer only expressions that need actual execution data.

```typescript
import { Form } from "@pf/process"

const review = new Form(flow, "Review", {
  role: employeeRole,
  form: ({ value }) => ({
    item: TextField({ readOnly: true, default: value((state) => state.item) }),
    approved: ES.Boolean,
  }),
})
```

See [Constructor Form authoring](../../docs/business-process-modelling/constructor-form-authoring.md)
for content, defaults, queries, nested fields, forEach and compatibility.
There is one supported Form API: the constructor with inline lazy helpers.
Ordinary static declarations keep their syntax:

```typescript
// Static form - no state access needed
const submitForm = new Form(process, "Submit", {
  role: employeeRole,
  form: () => ({
    item: ES.String,
    value: ES.NumberFromString,
  }),
})

// Form without input fields (confirmation only)
const confirmForm = new Form(process, "Confirm", {
  role: hrRole,
  form: () => ({}),
})
```

### Forms with State Access

Use `new Form(flow, ...)` with a flow scope to create forms that access
accumulated process state. The declaration receives helpers; their callbacks
receive typed state/context/item at runtime:

```typescript
const submitForm = new Form(process, "Submit", {
  role: employeeRole,
  form: () => ({
    item: ES.String,
    value: ES.NumberFromString,
  }),
})

const flow = process.start(submitForm)

const approveForm = new Form(flow, "Approve", {
  role: managerRole,
  form: ({ value }) => ({
    // state.item and state.value are typed from submitForm
    itemDisplay: TextField({
      label: "Item to approve",
      readOnly: true,
      default: value((state) => state.item),
    }),
    costDisplay: TextField({
      label: "Cost",
      readOnly: true,
      default: value((state) => String(state.value)),
    }),
    approved: BooleanField({ label: "Approve?" }),
  }),
})

flow.next(approveForm)
```

**Key points:**
- All forms use the `form` property to define fields
- Use `() => ({...})` for static forms without state access
- Use `value((state, ctx, item) => ...)` for runtime defaults and presentation
- Pass a flow (return value of `.start()` or `.next()`) as scope to access state
- Use `content(resolve, fallback)` for a conditional structural leaf, with no extra container
- Use `query(state => (filter, limit) => effect)` for state-dependent queries;
  leave state-independent query functions as written

### When to Use State Access

| Use Case | Approach |
|----------|----------|
| First form in process | `form: () => ({...})` |
| Form with fixed fields | `form: () => ({...})` |
| Form without fields | `form: () => ({})` |
| Form showing previous values | `form: ({ value }) => ({ ... default: value(state => ...) ... })` |
| Form with computed defaults | `form: ({ value }) => ({ ... default: value(state => ...) ... })` |

### Stable value-bearing form shape

The constructor runs the declaration once with authoring helpers and never
evaluates their callbacks to discover schemas. Its restricted helpers preserve
value-bearing paths, schemas, optionality, requiredness and submission
classification without constructing a second runtime schema tree.

Always author value-bearing fields. Use `Schema.optional` for an optional *value*;
an optional or conditional *definition key* fails typecheck. Conditional structural
presentation (`TextBlock`, `LinkButton`, and wrappers containing only structural
content) remains valid. Defaults, labels, text, links, and lookup/calendar query
closures may depend on state, context, or the current item. Use Form Rules for
hidden, disabled, and conditionally required behavior based on submitted values;
Form Rules do not read process state.

```ts
form: ({ value }) => ({
  returneeName: TextField({
    readOnly: true,
    default: value((state) => state.returneeName ?? ""),
  }),
  receivedKey: BooleanField({ required: true }),
})
```

Schema validation remains authoritative at submission. Representative-state
contract tests verify actual defaults, presentation, queries and persistence;
runtime helpers cannot replace the declared value schemas.

### Summary for Todo Cards

Forms can define a `summary` function that computes contextual information
displayed on todo cards. This helps users understand the task at a glance:

```typescript
const approveForm = new Form(flow, "Approve", {
  form: () => ({
    approved: BooleanField({ label: "Approve?" }),
  }),
  summary: (state) => ({
    When: formatDate(state.requestedDate),
    Requester: state.employeeName,
    Amount: `<strong>$${state.amount}</strong>`,
  }),
  role: managerRole,
})
```

**Key points:**
- Returns `Record<string, string>` where keys are labels, values are display strings
- Using Record prevents duplicate labels
- Values can contain HTML for formatting
- Returns empty object by default if not defined
- Computed during todo sync, displayed on frontend todo cards

### Using Context in Summary

The `summary` function receives a second `context` parameter with metadata about
completed steps, useful for showing who performed previous actions:

```typescript
const approveForm = new Form(flow, "Approve", {
  role: managerRole,
  form: () => ({ approved: ES.Boolean }),
  summary: (state, context) => ({
    "Requested by": context.submitRequest.providerUser.name,
    "Amount": `$${state.amount}`,
  }),
})
```

Context keys are camelCased step names. Each completed step provides:

```typescript
interface StepMeta {
  user: {
    userId: string       // User ID (e.g., "usr-01ABC...")
    sub: string          // Subject from auth provider
  }
  providerUser: {
    id: string           // Provider user ID
    name: string         // Full name
    firstName: string    // First name
    lastName: string     // Last name
    email: string        // Email address
    picture: string      // Profile picture URL
  }
  completedAt: DateTime.DateTime  // When step was completed
}
```

Access process-level info via `context.process`:

```typescript
summary: (state, context) => ({
  "Initiated by": context.process.startStep.providerUser.name,
  "Approved by": context.step.managerApproval.providerUser.name,
})
```

# Authentication Configuration

Configure OAuth providers and passkey authentication for your organisation:

```typescript
import { Organisation } from "@pf/organisation"
import { AuthenticationConfig } from "@pf/process"

const org = new Organisation({ name: "MyOrg" })

new AuthenticationConfig(org, "auth", {
  providers: {
    google: {
      clientID: process.env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      scopes: ["openid", "email", "profile"],
    },
    github: {
      clientID: process.env.GITHUB_CLIENT_ID ?? "",
      clientSecret: process.env.GITHUB_CLIENT_SECRET ?? "",
      scopes: ["user:email"],
    },
  },
  passkey: {
    rpName: "My Application",
    rpID: "example.com",
    origin: "https://example.com",
  },
})
```

# Implementation

## Key Features

1. **Automatic Type Inference**: Types are inferred from Effect Schema
   definitions
2. **State Accumulation**: Each `.next()` call merges the new step's input
   into the accumulated state
3. **Type-Safe Conditions**: Condition functions receive properly
   typed state
4. **Compile-Time Errors**: TypeScript will catch errors if you try to access
   fields that aren't in the state yet
5. The flow is tracked using
   [graphology](https://graphology.github.io/) with a directed graph.
6. Every step is a node in the graph.
7. Steps can be linked unconditionally or conditionally.

# Writing business processes

## Technical Details

The type system uses:
- Generic type parameters on `Step<TState, TInput>`
- Effect Schema's `Schema.Struct.Type` for type inference
- TypeScript's type-level intersection (`&`) to merge state types
- Conditional types to extract types from Effect Schema definitions

## Type-safety

When you define steps with form fields, those types are automatically
inferred and accumulated through the process flow.

### IMPORTANT: You Must Capture Return Values

The accumulated state is in the **return value** of `.next()`, not in
the original step variable. You must either:

1. Chain calls together in one expression, OR
2. Capture the return value in a new variable

**❌ WRONG** - This loses state accumulation:

```typescript
const step1 = new Form(this, "Step1", {
  form: () => ({ name: ES.String }),
})
const step2 = new Form(this, "Step2", {
  form: () => ({ age: ES.Number }),
})

process.start(step1)  // Returns Step<{ name: string }>
step1.next(step2)     // ❌ step1 is still Step<Record<string, never>>!
step2.next(step3, state => {
  state.name  // ❌ Error: name doesn't exist on step2's state
})
```

**✅ CORRECT** - Chain in one expression:

```typescript
process.start(step1)
  .next(step2, state => {
    state.name  // ✅ Available
    return true
  })
  .next(step3, state => {
    state.name  // ✅ Available
    state.age   // ✅ Available
    return true
  })
```

**✅ ALSO CORRECT** - Capture return values:

```typescript
const flow1 = process.start(step1)
const flow2 = flow1.next(step2)
const flow3 = flow2.next(step3, state => {
  state.name  // ✅ Available
  state.age   // ✅ Available
  return true
})
```

**✅ ALSO CORRECT** - Capture flow values with NodeStep:

Instead of chaining `.next()` calls, you can use flow variables to
capture accumulated state. This allows you to define steps naturally
and access accumulated state in their `execute` callbacks:

```typescript
const step1 = new Step(process, "Step1", {
  role: hrRole,
  input: { name: ES.String }
})

// Start returns a typed flow with accumulated state
const flow1 = process.start(step1)

// Create step2 using flow1 as scope - NodeStep for system execution
const step2 = new NodeStep(flow1, "Step2", {
  role: hrRole,
  input: { age: ES.Number },
  execute: (state) => {
    state.name  // ✅ Available from step1
    state.age   // ✅ Available from step2's input
  }
})

// Connect step2 to get flow with accumulated state
const flow2 = flow1.next(step2, (state) => {
  state.name  // ✅ Available
  // age is NOT available here - condition runs before transitioning
  return state.name.length > 0
})

// Create step3 using flow2 as scope - NodeStep for system execution
const step3 = new NodeStep(flow2, "Step3", {
  role: hrRole,
  input: { email: ES.String },
  execute: (state) => {
    state.name   // ✅ Available from step1
    state.age    // ✅ Available from step2
    state.email  // ✅ Available from step3's input
  }
})
```

**Key points:**
- Flow variables (like `flow1`, `flow2`) carry accumulated state types
- Use a flow as the scope when creating a new Step or NodeStep
- Use `NodeStep` for system steps that execute TypeScript code
- The `execute` callback receives accumulated state + the step's own input
- Condition callbacks in `.next()` receive state BEFORE the target step's input
