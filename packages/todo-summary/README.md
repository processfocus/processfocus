# @pf/todo-summary

Computes the contextual summaries shown on Todo cards from authored Form
summaries, process state, and completed-step information.

The GraphQL API and background event handlers share this service so initial
loads and realtime updates present the same task context.

Summary declarations belong to [`@pf/process`](../process/README.md).
