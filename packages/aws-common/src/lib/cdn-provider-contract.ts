/** Caller semantics, independent of application revisions and CDN stack schema. */
export const CDN_PROVIDER_CONTRACT = {
  schema: 1,
  capabilities: ["alias-only-preparation", "alias-certificate-preparation"],
} as const

export const CDN_PROVIDER_CONTRACT_OUTPUT = "CallerContract"
