import { Console, Effect } from "effect"
import { CustomDomainError } from "../errors"
import { graphqlRequestWithCredentials } from "../utils/graphql-client"
import { ensureKnownEnvironmentName } from "../utils/remote-name-validation"

const GET_CUSTOM_DOMAIN_QUERY = `
  query GetDnsRecords($projectId: String!, $environmentId: String!) {
    getDnsRecords(projectId: $projectId, environmentId: $environmentId) {
      defaultDomain
      frontendUrl
      frontendUrlNote
      customDomain
      certificateStatus
      warnings
      validationRecords {
        type
        name
        value
        purpose
      }
      validationNote
      siteAccessRecord {
        type
        name
        value
        purpose
      }
      siteAccessNote
      postscriptNotes
    }
  }
`

interface DnsRecord {
  readonly type: string
  readonly name: string
  readonly value: string
  readonly purpose: string
}

interface GetCustomDomainResponse {
  readonly getDnsRecords: {
    readonly defaultDomain: string
    readonly frontendUrl: string
    readonly frontendUrlNote: string | null
    readonly customDomain: string | null
    readonly certificateStatus: string | null
    readonly warnings: readonly string[]
    readonly validationRecords: readonly DnsRecord[]
    readonly validationNote: string | null
    readonly siteAccessRecord: DnsRecord | null
    readonly siteAccessNote: string | null
    readonly postscriptNotes: readonly string[]
  }
}

const formatDnsRecord = (record: DnsRecord) =>
  `  ${record.type} ${record.name} -> ${record.value}  (${record.purpose})`

export const runCustomDomain = (projectId: string, environmentId: string) =>
  ensureKnownEnvironmentName(projectId, environmentId).pipe(
    Effect.flatMap(() =>
      graphqlRequestWithCredentials<GetCustomDomainResponse>(
        GET_CUSTOM_DOMAIN_QUERY,
        {
          projectId,
          environmentId,
        },
      ),
    ),
    Effect.mapError(
      (error) =>
        new CustomDomainError({
          message: error.message,
          cause: error.cause,
        }),
    ),
    Effect.flatMap(({ getDnsRecords }) =>
      Effect.gen(function* () {
        for (const warning of getDnsRecords.warnings) {
          yield* Console.log(warning)
        }

        if (getDnsRecords.warnings.length > 0) {
          yield* Console.log("")
        }

        if (!getDnsRecords.customDomain) {
          yield* Console.log(
            `No custom domain configured for ${projectId}/${environmentId}.`,
          )
          yield* Console.log(`Frontend URL: ${getDnsRecords.frontendUrl}`)
          return
        }

        yield* Console.log(`Custom domain: ${getDnsRecords.customDomain}`)
        if (getDnsRecords.certificateStatus) {
          yield* Console.log(`Status: ${getDnsRecords.certificateStatus}`)
        }
        yield* Console.log(`Frontend URL: ${getDnsRecords.frontendUrl}`)
        if (getDnsRecords.frontendUrlNote) {
          yield* Console.log(`Note: ${getDnsRecords.frontendUrlNote}`)
        }
        yield* Console.log("")
        yield* Console.log("Required DNS records:")

        if (getDnsRecords.validationRecords.length > 0) {
          for (const record of getDnsRecords.validationRecords) {
            yield* Console.log(formatDnsRecord(record))
          }
        } else if (getDnsRecords.validationNote) {
          yield* Console.log(`  (${getDnsRecords.validationNote})`)
        }

        if (getDnsRecords.siteAccessRecord) {
          yield* Console.log(formatDnsRecord(getDnsRecords.siteAccessRecord))
        } else if (getDnsRecords.siteAccessNote) {
          yield* Console.log(`  (${getDnsRecords.siteAccessNote})`)
        }

        if (getDnsRecords.postscriptNotes.length > 0) {
          yield* Console.log("")
          for (const note of getDnsRecords.postscriptNotes) {
            yield* Console.log(note)
          }
        }
      }),
    ),
  )
