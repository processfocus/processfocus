import {
  type ACMClient,
  type CertificateSummary,
  ListCertificatesCommand,
} from "@aws-sdk/client-acm"

export const ACM_REGION = "us-east-1"

const ACM_LIST_PAGE_SIZE = 100
const ACM_LIST_MAX_PAGES = 20

const ACM_CERTIFICATE_STATUSES = [
  "ISSUED",
  "PENDING_VALIDATION",
  "INACTIVE",
  "EXPIRED",
  "VALIDATION_TIMED_OUT",
  "REVOKED",
  "FAILED",
] as const

export const listAllCertificates = async (
  acm: ACMClient,
): Promise<CertificateSummary[]> => {
  const certificates: CertificateSummary[] = []
  let nextToken: string | undefined
  let pages = 0

  do {
    pages += 1
    if (pages > ACM_LIST_MAX_PAGES) {
      throw new Error(
        `Exceeded ACM ListCertificates pagination limit (${ACM_LIST_MAX_PAGES} pages of ${ACM_LIST_PAGE_SIZE}). Too many certificates to auto-discover custom-domain cert. Set SSM parameter /pf-<project>/env/<env>/custom-domain-cert-arn and retry.`,
      )
    }

    const result = await acm.send(
      new ListCertificatesCommand({
        NextToken: nextToken,
        MaxItems: ACM_LIST_PAGE_SIZE,
        CertificateStatuses: [...ACM_CERTIFICATE_STATUSES],
      }),
    )

    certificates.push(...(result.CertificateSummaryList ?? []))
    nextToken = result.NextToken
  } while (nextToken !== undefined)

  return certificates
}
