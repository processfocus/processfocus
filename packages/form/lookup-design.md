# Lookup fields

A lookup selects an identity, not arbitrary text. Typing searches the choices;
selecting a result supplies its ID. Editing the selected label clears that
selection. Use `SuggestionField` when free text is a valid answer.

## Choosing a datasource

- **Local:** download a complete, bounded set of eligible choices and filter it
  in the browser. Use this for small datasets. Exceeding the authored bound is a
  load error, not a partial list or an automatic switch to server search.
- **Server:** search the eligible datasource as the user types. Use this for
  larger datasets. Truncated results ask the user to refine their search.

Both modes match labels and explicitly supplied search text. Matching ignores
case and accents, with exact and prefix label matches ranked first.

## Restored selections

An existing value may be absent from the current suggestions. Resolve its label
and eligibility independently rather than searching a limited results page.
Unavailable selections need to be cleared or replaced.

Datasource queries and eligibility checks belong on the server. Cached choices
help interaction, but the server still validates the submitted selection.
Changing a dependency clears the old selection and its cached choices.

See [`@pf/form-schema`](../form-schema/README.md) for declarations and
[the architectural decision](../../docs/adr/0034-lookups-use-explicit-local-or-server-typeahead.md)
for the rationale.
