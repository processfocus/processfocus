# pforg command reference

Generated from the CLI's command declarations. Start with the
[README](../README.md) for an overview, or use `pforg <command> --help`.
Shell completions are available through `pforg --completions bash`
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

Commands use your organisation login and Dashboard permissions. The generated
syntax does not describe every runtime validation:

- Record creation and updates require exactly one of `--input`, `--input-file`
  or `--input-stdin`, containing a JSON object.
- Process input must also be a JSON object.
- Record sort fields and available operations come from `lists describe`.
- Page numbers and page sizes must be positive.

## Generated command syntax
