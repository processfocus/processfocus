# About

Package containing the Effect Service definitions of all database
operations the graphql server needs to perform.

There is no real logic behind the various services, just a grouping
that feels more or less natural for a set of related operations.

Concrete implements are provided by `sqlite-operations` and
`postgres-operations`. Having a shared service definition allows us to
statically verify both sqlite and postgres implement the same operations.
