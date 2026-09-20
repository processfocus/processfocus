# About

This library parses the DDL portion of Xplain, the semantic database language.

It uses the [Effect library](https://effect.website/docs/getting-started/why-effect/) for error handling.

# Xplain

## Xplain bases and types

The basic idea behind Xplain is that we have a base (domains or column
types), and types (tables):

```
base a1 (A10). # text field, max 10 characters)

type t1 = a1. # table with two columns: uuid primary key, and a1.
```

We support the following bases:

```
base a1 (A10). # text field, max 10 characters)
base a2 (B). # Boolean
base a3 (C256). # Case-insensitive text, max 256 characters
base a4 (D). # Date time without time zone (always in UTC)
base a5 (I5). # Integer, max 5 digits.
base a6 (J). # JSON
base a7 (R10,2). # Real number: 10 digits before the comma, 2 after.
base a8 (T). # Unlimited text field.
base a9 (U). # URN/ARN

type t2 = a1, a2, a3, a4, a5, a6, a7, a8, a9.
 # type with columns: uuid primary key + attributes
```

Attributes are always not null unless the `optional` keyword is used:

```
type t1 = optional a1.
```

Note that in Xplain it's very usual to have spaces in base or type
names. Underscores have a special meaning.

## Derived types

We use the underscore to create attributes with an name different than
the base, but with the base type:

```
base quantity (I5).
base price (R10,2).

type t2 = quantity, unit_price.
```

Type `t2` here has an column named `unit_price`, but it's a `price`,
just named with a prefix. It's data type is `(R10,2)`.

## ID prefixes

You can optionally specify a prefix for the generated ID column:

```
base task (A64).

type todo "td" = task. # ID will be prefixed with "td"
type done = task.      # No prefix (standard UUID)
```

The prefix string is stored in the AST and can be used by code generators
(like xplain2sql) to create human-readable IDs such as `td-123` instead
of pure UUIDs.

**Validation rules for ID prefixes:**
- Prefix cannot be empty
- Must contain only lowercase letters (a-z)
- Maximum length is 4 characters

## Case-Insensitive Text (C)

The `C` type provides case-insensitive text storage:

```
base name (C1024).
base email (C320).
```

**Database Mapping:**
- **PostgreSQL**: Maps to `citext` type (requires `CREATE EXTENSION citext`)
- **SQLite/Turso**: Maps to `TEXT COLLATE NOCASE` (ASCII-only case folding)

**Length Constraint:**
The maximum length (e.g., `C1024`) is for documentation and application-level validation only. It is NOT enforced at the database level because:
- PostgreSQL `citext` doesn't support length constraints
- SQLite `TEXT COLLATE NOCASE` doesn't enforce length

**Use Cases:**
- User names
- Email addresses
- Any text that should be compared case-insensitively

**Limitations:**
- SQLite's `COLLATE NOCASE` only handles ASCII characters (A-Z)
- PostgreSQL `citext` requires the citext extension
- Not available on AWS DSQL (use application-level normalization instead)

## Indexes

We can also create indexes:

```
index t1 its index1 = a1.
```

This creates a non-unique index `index1` on the `t1 table.

```
unique index t1 its index2 = a1.
```

This creates a unique index `index2` on the `t1 table.

## Defaults

Setting a default value for an attribute:

```
base a1 (A10). # text field, max 10 characters)
base created_at (D).

type t1 = a1, created_at.

default t1 its created_at = systemdate.
default t1 its a1 = "abc".
```

Default values can be overridden upon insert.

## Inits

An initialision value is much like a default, but cannot be overridden
for an insert, only by an update:

```
base name (A64).
base date (D).
base quantity (I4.
base price (R10,2).

type customer = name.
type product = name, unit_price.
type invoice = customer, date.
type invoice line = invoice, product, quantity, unit_price.

init invoice line its unit_price = product its price.
```

Note here that expressions can be quite complicated, i.e. they can
reference other attributes. A default can do the same.

For example we could define a default discount this way:

```
init invoice line its unit_price = if quantity >= 100 then product its price * 0.8 else product its price.
```

## Extends

With an assert we can create virtual attributes (calculated columns):

```
extend invoice line with amount = quantity * unit_price.
```

We can also use a retrieval function:

```
extend invoice with total = sum invoice line its amount per invoice.
```

There are 7 retrieval functions:
1. **count**: returns the number of elements in a set.
2. **max**: returns the maximum value of a set of attribute values.
3. **min**: returns the minimum value of a set of attribute values.
4. **total**: returns the sum of the values of a set of attribute values.
5. **nil**: returns `true` if the selected set equals the empty set, otherwise `false`.
6. **any**: returns `false` if the selected set equals the empty set, otherwise `true`.
7. **some**: returns a randomm element of the selected set.

## Asserts

An assert works like an extend, but can verify that the virtual attribute obeys a particular value range:

```
assert invoice line its amount (0..*) = quantity * unit_price.
```

## Specializations

Specializations model a 1:0-1 relationship between types. Where a regular attribute creates a 1:n relationship (one parent, many children), a specialization creates a relationship where the parent can have zero or one specialized instance.

### Syntax

Use square brackets around a type name to create a specialization:

```xplain
type house = [building].
type office = [building].
```

In this example:
- Both `house` and `office` are specializations of `building`
- A building can have 0 or 1 house
- A building can have 0 or 1 office
- A house must reference a building
- An office must reference a building

### Specialization vs Regular Attributes

Regular attribute (1:n relationship):
```xplain
type room = building.
```
This means: a room must have one building, and a building can have 0 or more rooms.

Specialization (1:0-1 relationship):
```xplain
type apartment = [building].
```
This means: an apartment must reference one building, but a building can have 0 or at most 1 apartment.

### Role Prefixes

Like regular attributes, specializations support role prefixes:

```xplain
type office = [commercial_building].
```

The role prefix `commercial_` distinguishes this reference from other potential building references.

### Rules and Constraints

1. **Must reference a type**: Specializations can only reference types, not bases
   ```xplain
   base name (A64).
   type house = [name].  # ERROR: Cannot specialize a base
   ```

2. **Cannot be optional**: Specializations are always implicitly 0..1, so the `optional` keyword is not allowed
   ```xplain
   type building = name.
   type house = optional [building].  # ERROR: Specializations cannot be optional
   ```

3. **Can be mixed with regular attributes**:
   ```xplain
   type house = address, [building].
   ```

4. **Multiple specializations allowed**:
   ```xplain
   type hybrid = [building], [vehicle].
   ```

### Use Cases

Specializations are ideal for modeling:
- Subtypes/inheritance relationships
- Exclusive relationships (each parent has at most one specialized instance)
- Extension tables in database design

Example:
```xplain
base name (A64).
base address (A128).
base bedrooms (I2).
base desks (I3).

type building = name, address.
type house = bedrooms, [building].
type office = desks, [building].
```

In this model, a building can be specialized as either a house (with bedrooms) or an office (with desks), but not both simultaneously at the database constraint level (though the system can model a building with both a house and office record).

## Directed graph

Xplain enforces a database schema that models an acyclic directed
graph. This has many advantages in particular when displaying the schema visually.
