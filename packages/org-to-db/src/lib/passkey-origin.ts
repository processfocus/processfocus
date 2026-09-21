export const passkeyOriginOverride = (
  env: NodeJS.ProcessEnv,
): { readonly rpID: string; readonly origin: string } | undefined => {
  // FRONTEND_BASE_URL is also set by hosted deployments for link generation.
  // Only the local launcher opts into a separate WebAuthn ceremony origin.
  const origin = env["PF_LOCAL_FRONTEND_ORIGIN"] ?? env["OAUTH_ISSUER_URL"]
  return origin ? { rpID: new URL(origin).hostname, origin } : undefined
}
