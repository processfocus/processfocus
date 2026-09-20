import { Console, Effect } from "effect"
import { createClientJwt, storeFrontendJwt } from "@pf/auth-api"
import { getAudience, getClientId } from "@pf/auth-session"
import { DATABASE_PATH_NOT_CONFIGURED, resolveDatabasePath } from "@pf/db-info"
import { OrgLoadError } from "../errors"
import { makeFrontendJwtStorageLayer } from "../utils/frontend-jwt-storage-layer"
import { resolveIssuerUrl } from "../utils/resolve-issuer-url"

/**
 * Refresh (re-create) the frontend JWT token.
 *
 * Creates a new frontend JWT signed with the current keys and issuer
 * URL, then stores it in the database. Use this when:
 * - The deployed auth server issuer URL has changed
 * - The signing keys have changed (e.g. database was recreated)
 * - You need to force-regenerate the token for any reason
 *
 * @param orgPath - Path to organisation directory (to resolve database path)
 */
interface RefreshFrontendJwtDependencies {
  readonly issuedAtUnixSeconds?: () => number
}

export const runRefreshFrontendJwt = (
  orgPath: string,
  dependencies: RefreshFrontendJwtDependencies = {},
) =>
  Effect.gen(function* () {
    const databasePath = resolveDatabasePath(orgPath)

    if (!databasePath) {
      return yield* new OrgLoadError({
        path: orgPath,
        cause: DATABASE_PATH_NOT_CONFIGURED,
      })
    }

    const appLayer = makeFrontendJwtStorageLayer(databasePath)

    const issuerUrl = resolveIssuerUrl()
    const clientId = getClientId()
    const audience = getAudience()

    yield* createClientJwt({
      clientId,
      issuerUrl,
      audience,
      ...(dependencies.issuedAtUnixSeconds
        ? { issuedAtUnixSeconds: dependencies.issuedAtUnixSeconds() }
        : {}),
    }).pipe(
      Effect.flatMap((token) => storeFrontendJwt(clientId, token)),
      Effect.provide(appLayer),
    )

    yield* Console.log(
      `Frontend JWT refreshed (issuer: ${issuerUrl}, audience: ${audience})`,
    )
  })
