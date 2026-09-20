import type { GraphQLClient } from "graphql-request"
import { gql } from "graphql-request"
import { processWorkflowQuery } from "@/lib/graphql/workflow-queries"

const processesQuery = gql`
  query AuthorizationPullProcess($limit: Int!) {
    pullProcess(limit: $limit) {
      documents {
        name
        path
        startStepPath
        deleted
      }
    }
  }
`

interface ProcessRow {
  name: string
  path: string
  startStepPath: string
  deleted: boolean
}

export interface AuthorizationProcessStart {
  name: string
  path: string
  startStepPath: string
  startRolePath: string | null
  startEmbedded: boolean
}

export const fetchAuthorizationProcesses = async (
  client: GraphQLClient,
): Promise<AuthorizationProcessStart[]> => {
  const data = await client.request<{
    pullProcess: { documents: ProcessRow[] }
  }>(processesQuery, { limit: 200 })
  const processes = data.pullProcess.documents.filter(
    (row) => !row.deleted && row.startStepPath,
  )

  return Promise.all(
    processes.map(async (row) => {
      try {
        const workflow = await client.request(processWorkflowQuery, {
          processPath: row.path,
        })
        const start = workflow.processWorkflow?.steps.find(
          (step) => step.isStartStep || step.path === row.startStepPath,
        )
        return {
          name: row.name,
          path: row.path,
          startStepPath: row.startStepPath,
          startRolePath: start?.role?.path ?? null,
          startEmbedded: start?.isEmbedded ?? false,
        }
      } catch {
        return {
          name: row.name,
          path: row.path,
          startStepPath: row.startStepPath,
          startRolePath: null,
          startEmbedded: false,
        }
      }
    }),
  )
}
