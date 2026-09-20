import { Construct, type IConstruct } from "constructs"
import isFQDN from "validator/lib/isFQDN"

export interface CustomDomainProps {
  /**
   * Map of environment name to custom domain.
   * Environments not listed use the default managed app domain.
   */
  readonly domains: Record<string, string>
}

/**
 * Declares optional per-environment custom domains for an organisation.
 *
 * This construct is consumed at deploy-time from the bundled org model.
 */
export class CustomDomain extends Construct {
  /**
   * Brand for cross-bundle duck-typing.
   * (instanceof checks do not work across separately bundled code)
   */
  readonly isCustomDomain = true as const

  readonly domains: Readonly<Record<string, string>>

  constructor(scope: IConstruct, id: string, props: CustomDomainProps) {
    super(scope, id)

    const normalizedDomains: Record<string, string> = {}

    for (const [env, domain] of Object.entries(props.domains)) {
      const normalized = domain.trim().toLowerCase()

      if (
        !isFQDN(normalized, {
          require_tld: true,
          allow_underscores: false,
          allow_trailing_dot: false,
          allow_wildcard: false,
        })
      ) {
        throw new Error(
          `Custom domain for env "${env}" must be a valid domain name, got: ${domain}`,
        )
      }

      if (
        normalized === "app.processfocus.com" ||
        normalized.endsWith(".app.processfocus.com")
      ) {
        throw new Error(
          `Custom domain for env "${env}" cannot be under app.processfocus.com`,
        )
      }

      normalizedDomains[env] = normalized
    }

    this.domains = normalizedDomains
  }

  /**
   * Returns the configured custom domain for an environment, if any.
   */
  domainForEnvironment(env: string): string | undefined {
    return this.domains[env]
  }
}
