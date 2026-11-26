# pfcli command reference

Generated from the CLI's command declarations. Start with the
[README](../README.md) for an overview, or use `pfcli <command> --help`.
Shell completions are available through `pfcli --completions bash`
(also `zsh`, `fish` and `powershell`).

## Common options

These runner options are available on every command but are omitted from the
generated syntax:

| Option | Use |
| --- | --- |
| `--help`, `-h` | Show command help. |
| `--version`, `-v` | Print the installed version. |
| `--wizard` | Collect arguments interactively, then run the command. |
| `--completions` | Print completions for `bash`, `zsh`, `fish` or `powershell` (aliases `sh`, `pwsh`). |
| `--log-level` | Choose `all`, `trace`, `debug`, `info`, `warn`, `warning`, `error`, `fatal` or `none`. |

## Reading this reference

The generated syntax describes arguments and flags. Some requirements are
checked when the command runs:

- `init` needs at least one `--identity-provider`.
- Hosted deployment, log and database commands need both `--project` and `--env`.
- `destroy` needs `--yes`; `db upload` needs a file; `db rollback` needs a timestamp.
- `config set` accepts `KEY`, `KEY=VALUE` or `KEY VALUE`. `KEY` reads the
  exported environment variable.
- Commands with local and hosted modes cannot combine local database options
  with `--project`/`--env`.

Where supported, `PF_ORG` supplies an omitted organisation path even if the
generated syntax marks it required. A rollback timestamp without a timezone
uses the terminal's local timezone.

## Generated command syntax
