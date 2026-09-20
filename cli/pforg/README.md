# pforg

`pforg` is the Process Focus organisation-runtime CLI. It authenticates a
Provider User against one organisation Environment's Dashboard.

`pfcli` remains the Console hosting CLI and uses a separate login and
credentials file.

## Authentication

Log in by supplying the organisation Dashboard base URL explicitly:

```bash
pforg auth login https://environment.project.app.processfocus.com
pforg auth login http://localhost:3000
```

The command opens `<base-url>/cli-auth` in the default browser and stores the
result in `~/.config/pforg/credentials.json`. Set `PFORG_CREDENTIALS_PATH` to
use a different credentials file.

Check the current session without printing its access token:

```bash
pforg auth status
```

Missing and expired credentials exit with status 1 and ask the user to log in
again.

## Start a Process

Start a Process by its path. The command derives the organisation-generated
GraphQL mutation name and prints the immediate start payload as JSON:

```bash
pforg process start engineering/bug-report
pforg process start engineering/bug-report --input '{"field":"value"}'
```

`--input` must be a JSON object. The command exits after GraphQL returns; it
does not wait for a Todo or for the Process Execution to finish.

## Processes

List the Processes the logged-in Provider User can start. Success is always a
JSON array on stdout, including `[]` when there are no matching Processes.

```bash
pforg processes list
pforg processes list --page 2 --limit 25
pforg processes list --process-path /finance/purchase-request --status Active
```

## Todos

List the Todos the logged-in Provider User can complete. Success is always a
JSON array on stdout, including `[]` when there are no matching Todos.

```bash
pforg todos list
pforg todos list --page 2 --limit 25
pforg todos list --process-path /finance/purchase-request --status Active
```

## Process Executions

List the Process Executions the logged-in Provider User can view. Success is
always a JSON array on stdout, including `[]` when there are no matches.

```bash
pforg executions list
pforg executions list --page 2 --limit 25
pforg executions list --process-path /finance/purchase-request --status Running
```
