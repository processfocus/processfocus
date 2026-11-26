import { Console, Effect } from "effect"
import { CliError } from "../errors"
import { readWorkloadCredentials } from "../utils/credentials"
import { graphqlRequestWithCredentials } from "../utils/graphql-client"

const fields = `clientId name enabled status repository ref workflowRef environment permissions events
  targetIssuer assertionAudience enrollmentAudience repositoryId repositoryOwnerId workflowExample`

export const runWorkloadList = (projectId: string, clientId?: string) =>
  Effect.gen(function* () {
    const result = yield* graphqlRequestWithCredentials<{
      projectWorkloads: readonly { clientId: string }[]
    }>(
      `query($projectId: String!) { projectWorkloads(projectId: $projectId) { ${fields} } }`,
      { projectId },
    )
    const selected = clientId
      ? result.projectWorkloads.find((item) => item.clientId === clientId)
      : result.projectWorkloads
    if (!selected)
      return yield* new CliError({
        message: "Federated identity not found in project",
      })
    yield* Console.log(JSON.stringify(selected, null, 2))
  })

export const runWorkloadSave = (
  projectId: string,
  clientId: string | undefined,
  input: {
    name: string
    repository: string
    branch: string
    workflow: string
    environment?: string | undefined
    permissions: readonly string[]
    events: readonly string[]
    enabled: boolean
  },
) =>
  Effect.gen(function* () {
    const result = yield* graphqlRequestWithCredentials<{
      saveProjectWorkload: unknown
    }>(
      `mutation($projectId: String!, $clientId: String, $input: ProjectWorkloadInput!) {
      saveProjectWorkload(projectId: $projectId, clientId: $clientId, input: $input) { ${fields} }
    }`,
      { projectId, clientId, input },
    )
    yield* Console.log(JSON.stringify(result.saveProjectWorkload, null, 2))
  })

export const runWorkloadRemove = (projectId: string, clientId: string) =>
  Effect.gen(function* () {
    yield* graphqlRequestWithCredentials(
      `mutation($projectId: String!, $clientId: String!) { removeProjectWorkload(projectId: $projectId, clientId: $clientId) }`,
      { projectId, clientId },
    )
    yield* Console.log("Federated identity removed.")
  })

export const runWorkloadEnroll = () =>
  Effect.gen(function* () {
    const credentials = yield* readWorkloadCredentials()
    if (!credentials)
      return yield* new CliError({
        message:
          "Enrollment requires GitHub Actions OIDC federation mode (PFCLI_AUTH_MODE=github-workload) and the generated enrollment audience.",
      })
    yield* Console.log(
      "Enrollment exchange succeeded. Inspect the registration before deploying; remove the one-time enrollment step.",
    )
  })
