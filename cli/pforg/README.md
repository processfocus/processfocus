# pforg

`pforg` works with Processes, Todos, records and Invitations in a Process Focus
organisation. It uses your Dashboard permissions.

Use [pfcli](../pfcli/README.md) for building organisations and managing cloud
hosting. The two tools have separate logins.

## Log in

Supply the organisation Dashboard URL:

```bash
pforg auth login https://environment.project.app.processfocus.com
pforg auth status
```

For local development, use the local Dashboard URL instead. Credentials are
stored in `~/.config/pforg/credentials.json`; `PFORG_CREDENTIALS_PATH` selects a
different file.

## Processes and work

```bash
pforg processes list
pforg process start /finance/purchase-request --input '{"amount":100}'
pforg todos list
pforg executions list
```

Use a Process path and input fields defined by your organisation. Starting a
Process returns immediately after the start request; it does not wait for the
execution to finish.

After fixing the cause of a failed execution, use
`pforg executions restart <execution-id>` to retry its work.

## Lists and records

Discover the operations and fields available to you before reading or changing
records:

```bash
pforg lists list
pforg lists describe /contacts
pforg records list /contacts
pforg records get /contacts <record-id>
pforg records create /contacts --input '{"name":"Alex"}'
pforg records update /contacts <record-id> --input-file ./changes.json
```

Create and update accept one JSON object from `--input`, `--input-file` or
`--input-stdin`. Available operations and validation belong to the organisation's
List definition. After a lost response to a write, check the record before retrying.

## Invitations and passkeys

Administrators can create Invitations with explicit role paths:

```bash
pforg invitation create --email person@example.com --role "/Employee"
pforg invitation list
```

For passkey registration, add `--registration-link` when creating an Invitation,
or use `invitation registration-link` for an existing pending Invitation.
Links are secret, single-use credentials; deliver them privately. The command
does not send email. Account bootstrap and recovery are available through `pfcli`.

Use `pforg passkeys list` to see your own registered passkeys.

## Output and help

Data commands return JSON. Process, Todo, execution and record browsing is
paginated; use `--page` and `--limit` to continue. Invitation listing retrieves
all pages. Failed commands exit nonzero and report errors on stderr.

```bash
pforg --help
pforg records create --help
pforg --completions bash
```

The package includes a generated [command reference](dist/command-reference.md)
and [Usage spec](dist/pforg.usage.kdl), created during the build.
