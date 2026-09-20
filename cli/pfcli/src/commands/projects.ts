import { Console, Effect } from "effect"
import type { CliError } from "../errors"
import { graphqlRequestWithCredentials } from "../utils/graphql-client"

const PROJECTS_PAGE_SIZE = 100

const LIST_PROJECTS_QUERY = `
  query ListProjects($page: Int!, $limit: Int!) {
    listProjects(page: $page, limit: $limit) {
      items {
        projectNumber
        projectName
      }
      totalCount
    }
  }
`

interface ListProjectsResponse {
  readonly listProjects: {
    readonly items: ReadonlyArray<{
      readonly projectNumber: string
      readonly projectName: string
    }>
    readonly totalCount: number
  }
}

export const runProjects = (): Effect.Effect<void, CliError> =>
  Effect.gen(function* () {
    let page = 1
    let printedCount = 0
    let totalCount: number | undefined

    while (totalCount === undefined || printedCount < totalCount) {
      const response =
        yield* graphqlRequestWithCredentials<ListProjectsResponse>(
          LIST_PROJECTS_QUERY,
          { page, limit: PROJECTS_PAGE_SIZE },
        )

      const { items } = response.listProjects
      totalCount = response.listProjects.totalCount

      if (items.length === 0) {
        break
      }

      for (const item of items) {
        yield* Console.log(`${item.projectNumber}\t${item.projectName}`)
      }

      printedCount += items.length
      page += 1
    }

    if (printedCount === 0) {
      yield* Console.log("No projects found.")
    }
  })
