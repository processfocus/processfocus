# About

Defines rxdb collections used in the frontend as Effect Schema.

# Architecture

It uses the `generate-rxdb` tool to generate `rxdb.graphql` from the schema.

Run with:

```sh
npx nx run graphql-schema:build-rxdb
```

# JSON schema

RxDb only handles a limited form of the JSON schema, we deal with this
complexity in `toRxDbJsonSchema()`.
