# @pf/xplain-ddl

Parses Xplain's schema-definition language into a validated model for code
generation. The Process Focus [database schema](../db-schema/README.md) uses
this language.

## Reading a schema

A **base** defines a scalar domain; a **type** groups attributes into a record.
Attributes can refer to bases or other types.

```xplain
base name (A64).
base quantity (I5).
base price (R10,2).

type customer = name.
type product = name, unit_price.
type order = customer.
type order line = order, product, quantity.
```

Here `unit_price` uses the `price` base with a role prefix. Spaces are valid in
names, as in `order line`. References such as `order` and `product` express
relationships between records.

Statements end with a period. Comments start with `#`.

## Bases and scalar types

A base gives a meaningful name to a scalar type:

```xplain
base name (A64).           # Text, maximum 64 characters
base active (B).           # Boolean
base email (C320).         # Case-insensitive text
base created at (D).       # Date/time
base quantity (I5).        # Integer, maximum 5 digits
base metadata (J).         # JSON
base price (R10,2).        # Real: 10 digits before the decimal point, 2 after
base description (T).      # Unlimited text
base resource (U).         # URN/ARN
```

The database generator determines how these domains are stored. In particular,
case-insensitive text uses PostgreSQL `citext` or SQLite `COLLATE NOCASE`;
SQLite's case folding is ASCII-only. The declared `C` length is not enforced
by those database types.

## Optional attributes and role prefixes

Attributes are required unless marked `optional`:

```xplain
base name (A64).
base email (C320).

type customer = name, optional email.
```

A role prefix gives an attribute a distinct name while reusing a base or type.
This is especially useful when the same kind of value appears more than once:

```xplain
base name (A64).
base price (R10,2).

type customer = name.
type product = name, retail_price, wholesale_price.
type order = billing_customer, shipping_customer.
```

Both price attributes use the `price` domain. Both customer attributes refer to
`customer`, but describe different relationships.

## ID prefixes

A type can declare a short prefix for generated IDs:

```xplain
base task (A64).

type todo "td" = task.
type done = task.
```

The generator can use `td` to make Todo IDs recognisable. Prefixes contain one
to four lowercase letters; a type without a prefix uses the generator's normal
ID format.

## Indexes

Use `index` for lookups and `unique index` for uniqueness:

```xplain
base name (A64).
base email (C320).

type customer = name, email.

index customer its by name = name.
unique index customer its by email = email.
```

The name after `its` identifies the index; the attributes after `=` identify its
columns.

## Defaults and initializations

A default supplies a value when an insert does not provide one:

```xplain
base name (A64).
base created at (D).

type customer = name, created at.

default customer its name = "New customer".
default customer its created at = systemdate.
```

An initialization supplies the inserted value rather than allowing the caller
to override it. The value may still be changed by a later update. Expressions
can follow relationships using `its`:

```xplain
base name (A64).
base quantity (I5).
base price (R10,2).

type product = name, price.
type invoice line = product, quantity, price.

init invoice line its price =
  if quantity >= 100 then product its price * 0.8 else product its price.
```

This copies the product price onto each invoice line, applying a bulk discount.
It records an initial price rather than a value that continually follows the
product's current price.

## Derived values and assertions

`extend` defines a calculated attribute. Retrieval functions can combine
related records:

```xplain
base name (A64).
base quantity (I5).
base price (R10,2).

type customer = name.
type invoice = customer.
type invoice line = invoice, quantity, price.

extend invoice line with amount = quantity * price.
extend invoice with invoice amount = total invoice line its amount per invoice.
```

`per invoice` groups the invoice lines by their invoice reference. Other
retrieval functions include `count`, `min`, `max`, `nil` (is the set empty?),
`any` (is it nonempty?), and `some` (select an element).

An `assert` can attach a range to a calculated value:

```xplain
base quantity (I5).
base price (R10,2).

type invoice line = quantity, price.

assert invoice line its amount (0..*) = quantity * price.
```

Here the calculated amount must be non-negative; `*` means no upper bound.

## Specializations

A regular type reference allows many child records for one parent. Square
brackets declare a specialization, with at most one record of that
specialization per parent:

```xplain
base name (A64).
base address (A128).
base bedrooms (I2).
base desks (I3).

type building = name, address.
type room = building, name.
type house = [building], bedrooms.
type office = [building], desks.
```

A building can have many rooms, at most one house record, and at most one
office record. Each house or office must reference a building. The two
specializations are independent: these declarations do not prohibit a building
from having both.

Specializations refer to types, not scalar bases, and cannot be marked
`optional`. They also support role prefixes:

```xplain
base name (A64).
base desks (I3).

type building = name.
type office = [commercial_building], desks.
```

Here `commercial_` names the role of the building reference.

## Schema relationships

References between distinct types must not form cycles. Self-references are
allowed for structures such as a hierarchy and are implicitly optional:

```xplain
base name (A64).

type category = name, parent_category.
```

A category can have a parent category; a root category has none.

## Further reading

This package parses and validates the model. Database-specific SQL and Drizzle
generation belong to downstream tools.

See the [parser](./src/lib/parser.ts) for supported syntax and the
[schema source](../db-schema/xplain/schema.ddl) for its use in the system.
