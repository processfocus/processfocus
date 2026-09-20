import { Console, Effect } from "effect"
import { CliError } from "../errors"

type PfcliSkill = {
  readonly name: string
  readonly description: string
  readonly content: string
}

const coreSkillContent = `# pfcli agent skill

Use this guide when operating the Process Focus CLI from an agent.

## Start here

- Prefer the workspace command while developing in this repository: \`bun cli/pfcli/src/main.ts <command>\`.
- Prefer the installed command outside the monorepo: \`pfcli <command>\`.
- Use \`pfcli --help\` or \`pfcli <command> --help\` for structural command help.
- Do not print, persist, or quote access tokens, signed URLs, Turso tokens, SSM parameter values, AWS credentials, or raw secrets.
- If a command says to run \`pfcli auth login\`, authenticate before retrying remote commands.

## Common workflows

### Scaffold an organisation

\`\`\`bash
pfcli init <org-path> --email <admin-email> --identity-provider <provider>
\`\`\`

- Repeat \`--identity-provider\` for multiple providers.
- \`org-path\` may come from \`PF_ORG\`.
- The command creates the org template, installs released dependencies, imports the org, and creates the local frontend JWT.

### Build an organisation artifact

\`\`\`bash
pfcli build <org-path> [--output dist]
\`\`\`

- Produces \`dist/org.js\`, \`dist/graphql/org.graphql\`, and \`dist/cedar/\`.
- Use this before inspecting deployable org output.

### Import an organisation locally

\`\`\`bash
pfcli import <org-path>
\`\`\`

- Uses \`SQLITE_DATABASE_PATH\` or \`<org-path>/db/pf.db\`.
- Builds first when source is present, runs migrations, then imports the bundled model.

### Deploy a project environment

\`\`\`bash
pfcli deploy <org-path> --project <project-number> --env <environment-name>
pfcli deploy <org-path> --project <project-number> --env <environment-name> --no-wait
\`\`\`

- Requires \`pfcli auth login\` credentials.
- Builds the org, uploads the dist artifact, starts the backend deploy process, and waits by default.
- Project numbers and internal IDs are accepted. Prefer project numbers in user-facing examples.

### Mint a first-admin Registration Link

\`\`\`bash
# Local database
pfcli invitation registration-link [org-path] --email <invited-email>
pfcli invitation registration-link [org-path] --email <invited-email> --rotate

# Remote customer environment
pfcli invitation registration-link --project <project-number> --env <environment-name> --email <invited-email>
pfcli invitation registration-link --project <project-number> --env <environment-name> --email <invited-email> --rotate
\`\`\`

- Local mode resolves its database from \`SQLITE_DATABASE_PATH\`, \`org-path\`, or \`PF_ORG\`; remote mode requires \`--project\` and \`--env\` together plus \`pfcli auth login\` against Console.
- Local URLs use \`FRONTEND_BASE_URL\`, \`BASE_URL\`, or \`NEXT_PUBLIC_FRONTEND_URL\`. Local mode is a developer workflow, so it intentionally falls back to \`http://localhost:3000\` even when \`NODE_ENV\` is unset; configure an origin when the local frontend uses another address.
- Prints the Registration Link URL once to stdout. Do not copy that URL into logs, skill examples, or summaries; use a placeholder such as \`https://<env>.<project-number>.app.processfocus.com/register/passkey#token=<token>\`.
- A second generate without \`--rotate\` fails; pass \`--rotate\` to replace an active or expired pending link. Revoked pending links are refused.
- For an existing active account associated with an accepted or legacy-closed Invitation, \`--rotate\` issues a separate, single-use Passkey Recovery Link. It preserves current roles, existing passkeys, and Invitation history. Recovery requires current roles and an enabled passkey provider.
- Remote recovery additionally requires the explicit \`recoverProviderUser\` permission, initially granted only to Cloud Backend Administrators. Recovery links expire after 24 hours; rotation invalidates older links and sessions.
- Automated coverage verifies local token issuance and exchange at the authentication boundary. Completing passkey registration and signing in through the browser remains a manual acceptance step.

### Destroy a project environment

\`\`\`bash
pfcli destroy --project <project-number> --env <environment-name> --yes
pfcli destroy --project <project-number> --env <environment-name> --yes --no-wait
\`\`\`

- Requires \`pfcli auth login\` credentials.
- Project numbers and internal IDs are accepted. Prefer project numbers in user-facing examples.
- This is destructive: it deletes the environment's AWS stacks and environment record through the existing Backend process.
- \`--yes\` is mandatory and there is no interactive prompt.
- Waits for completion by default. \`--no-wait\` returns after the execution starts.

### List remote inventory

\`\`\`bash
pfcli projects
pfcli stage list --project <project-number>
pfcli env list --project <project-number> [--stage <stage-name>]
\`\`\`

### Manage stage configuration

\`\`\`bash
pfcli config list --project <project-number> --stage <stage-name>
pfcli config get --project <project-number> --stage <stage-name> <key>
pfcli config set --project <project-number> --stage <stage-name> KEY
pfcli config set --project <project-number> --stage <stage-name> KEY=VALUE
pfcli config set --project <project-number> --stage <stage-name> KEY VALUE
pfcli config set --project <project-number> --stage <stage-name> --secret KEY
pfcli config delete --project <project-number> --stage <stage-name> <key>
pfcli config copy-new --project <project-number> --stage <target-stage> --from-stage <source-stage>
\`\`\`

- The bare \`KEY\` form copies the exported environment variable of the same name and fails if it is unset. Use \`KEY=\` to explicitly set an empty value.
- Use \`--secret\` for values that must be stored as secure parameters.
- Never paste secret values into summaries or logs.

### Inspect runtime logs

\`\`\`bash
pfcli logs --project <project-number> --env <environment-name>
pfcli canary-logs --project <project-number> --env <environment-name>
\`\`\`

- Output is raw timestamped log messages from the cloud API.
- Do not promise streaming or a precise time window unless the CLI help says so.

## Database workflows

### Download a hosted database

\`\`\`bash
pfcli db download --project <project-number> --env <environment-name> [--output ./backup.sqlite]
\`\`\`

- Uses an authoritative engine value and short-lived read-only session from GraphQL.
- SQLite-engine downloads use Turso Sync; treat \`--output\` as reusable sync state and expect possible sidecars.
- TursoDB downloads stream and validate a logical dump into an ordinary SQLite file. Existing output is atomically replaced by a complete snapshot, not incrementally updated.
- A failed TursoDB download leaves existing output untouched and removes private temporary files.
- The first version is pull-only. Do not describe it as restore, backup verification, a backend snapshot artifact, or a document-store transfer.

### Upload a local database

\`\`\`bash
pfcli db upload --project <project-number> --env <environment-name> [--mode data-copy|exact-restore] <sqlite-file>
\`\`\`

- Uploads a local SQLite database through a signed document-store URL and waits for backend apply completion.
- This is destructive from the environment's point of view. Expect the backend to create a recovery snapshot before cutover.
- The default \`data-copy\` mode preserves the destination's cryptographic identity and stored frontend JWT, and discards imported OpenAuth sessions. Use \`exact-restore\` only when all uploaded state, including authentication keys and sessions, must replace destination state.
- SQLite-engine targets require a WAL artifact and use Turso file seeding. TursoDB targets use logical dump replay, accept the delete-journal artifacts produced by TursoDB downloads, filter Turso-owned objects, and preserve AUTOINCREMENT continuity.
- Do not print signed URLs or raw operation credentials.

### Open a live database shell

\`\`\`bash
pfcli db shell --project <project-number> --env <environment-name> [--ttl 15m]
\`\`\`

- Requires the external \`turso\` CLI on \`PATH\`.
- Opens a live read-write shell for the Active Environment Database.
- This is for investigation and emergency repair, not transfer, local SQLite access, restore, rollback, or backup workflows.

### Prepare a database rollback

\`\`\`bash
pfcli db rollback --project <project-number> --env <environment-name> --timestamp <iso-timestamp>
pfcli db rollback --project <project-number> --env <environment-name> --timestamp 2026-04-01T00:00:00Z --no-wait
\`\`\`

- Accepts RFC3339 / ISO-8601 timestamps. If no timezone is supplied, local terminal timezone is used.

## Authentication

\`\`\`bash
pfcli auth login
\`\`\`

- Uses \`BASE_URL\` when set, otherwise defaults to \`https://console.processfocus.com\`.
- The Console host is the canonical CLI auth endpoint for customer sessions.
- Stores CLI credentials under the Process Focus config directory.
- Remote commands use these credentials; do not edit credential files manually.

## Local runtime helpers

\`\`\`bash
pfcli get-frontend-jwt [org-path]
pfcli refresh-frontend-jwt [org-path]
\`\`\`

- \`org-path\` may come from \`PF_ORG\`.
- Use refresh when local auth/runtime issuer keys or URLs changed.

## Agent operating rules

- Ask for missing project, environment, stage, or org path values before taking remote action.
- Prefer read-only commands first when diagnosing: \`projects\`, \`stage list\`, \`env list\`, \`config list\`, \`logs\`, \`canary-logs\`.
- Treat \`destroy\`, \`db shell\`, \`db upload\`, \`db rollback\`, \`config set\`, \`config delete\`, \`stage add\`, \`env add\`, \`grant role\`, \`invitation registration-link\`, and \`deploy\` as state-changing.
- For state-changing production actions, confirm target project/environment/stage unless the user already specified them clearly.
- If command output is JSON status lines, preserve important IDs and final status, but redact secrets.
- Re-run \`pfcli skills get core\` after upgrading \`pfcli\` instead of relying on cached guidance.`

const skills: readonly PfcliSkill[] = [
  {
    name: "core",
    description: "Core pfcli workflows, safety rules, and command guidance",
    content: coreSkillContent,
  },
]

export const runSkillsList = () =>
  Effect.gen(function* () {
    for (const skill of skills) {
      yield* Console.log(`${skill.name}\t${skill.description}`)
    }
  })

export const runSkillsGet = (name: string) =>
  Effect.gen(function* () {
    const skill = skills.find((candidate) => candidate.name === name)

    if (skill === undefined) {
      yield* new CliError({
        message: `Unknown pfcli skill "${name}". Available skills: ${skills.map((candidate) => candidate.name).join(", ")}`,
      })
    } else {
      yield* Console.log(skill.content)
    }
  })
