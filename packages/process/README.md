# @pf/process

The internal authoring SDK for Process Focus organisations and business
processes. The public authoring package is
[`processfocus`](../sdk/README.md).

## Mental model

- An Organisation contains organisational units, roles, processes, and shared
  configuration.
- A Process connects human Forms and automated steps into a flow.
- Submitted form values accumulate as process state, available to later steps.
- Transitions describe branching and scheduling; every reachable path must end.
- Lists provide views over organisation data.

Flow values carry the accumulated state type. Chain transitions or retain their
return values when defining later steps. Conditional flows include an explicit
else branch.

Forms combine a stable value schema with execution-specific defaults and
presentation. Visual grouping does not add nesting to submitted process state.

## Further reading

- [Business Process Modelling](../../docs/business-process-modelling/GLOSSARY.md)
- [Constructor Form authoring](../../docs/business-process-modelling/constructor-form-authoring.md)
- [Form fields](../form-schema/README.md)
- [Business calendars](../business-calendar/README.md)
