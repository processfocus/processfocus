# About

Fixed part of our graphql schema:
1. `system.graphql`: the nice graphql API.
2. `rxdb.graphql`: API specifically to make Tanstack DB work with RXDB
   to provide a sync engine experience in the frontend.

There is also a dynamic part, derived from the user's organisation
model. This file is generated per organisation.
