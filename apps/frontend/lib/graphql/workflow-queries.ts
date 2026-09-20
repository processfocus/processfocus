import { graphql } from "@/lib/generated/gql"

export const processWorkflowQuery = graphql(`
  query ProcessWorkflow($processPath: String!) {
    processWorkflow(processPath: $processPath) {
      processId
      processName
      processPath
      processPurpose
      steps {
        id
        name
        path
        purpose
        processId
        role {
          id
          name
          path
        }
        phase {
          id
          name
          path
          order
        }
        isStartStep
        isEmbedded
        column
      }
      flows {
        id
        sourceStepId
        targetStepId
        condition
        isElse
        isOnError
        taggedErrors
        schedule
      }
      responsibilities {
        roleId
        roleName
        rolePath
        responsibility
        order
      }
    }
  }
`)
