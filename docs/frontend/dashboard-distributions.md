# Dashboard distributions

Process Focus ships one generic Dashboard app and composes plugins at
build time. Do not call this app the **Console** or the **Backend**.

| Surface | What it is | What it is not |
| --- | --- | --- |
| **Dashboard** | The generic Process Focus UI in `apps/frontend`. Also called the Frontend when referring to the app or runtime artifact. | Console, Backend |
| **Backend** | The private cloud-org deployment of the **Dashboard**, used by Process Focus operators. Its own organisation artifact supplies its plugin implementations. | Console, customer UI |
| **Console** | The customer-facing cloud-hosting UI in `cloud/org/console`. It talks to the cloud-org GraphQL/Auth API and does not embed the Dashboard app. | Dashboard, Backend |

See `docs/cloud-hosting/CONTEXT.md` and ADRs 0010, 0011, 0020, and 0023.

## Plugin ownership

The implemented model follows [ADR 0023](../adr/0023-organisation-artifacts-own-plugin-implementations.md):
plugin implementations live in the organisation artifact. Process Focus supplies
versioned host contracts and platform adapters. There is no catalog or
package-source fallback.

## Current build contracts

`pfcli build <org>` writes `${PF_ORG}/dist/frontend-manifest.json`, the
versioned `${PF_ORG}/dist/browser-plugins.json` contract, and content-addressed
browser bundles and preparation stylesheets under
`${PF_ORG}/dist/browser-plugins/`.

| Target | Owner | Role |
| --- | --- | --- |
| `@pf/frontend:prepare-build-inputs` | Dashboard | Validates every selection against the organisation browser artifact and stages literal imports and stylesheets. |
| `@pf/frontend:next-build` | Dashboard | Production Next.js build. Depends on `prepare-build-inputs`. |
| `@pf/runtime-aws:build-frontend-for-opennext` | AWS runtime | Runs `@pf/frontend:next-build` with the selected organisation artifact. |
| `@pf/runtime-aws:build-opennext` | AWS runtime | Production-like OpenNext artifact used by hosted Dashboard deploys. |

## Artifact validation and isolation

Both local and hosted consumers read the frontend and browser manifests from
`${PF_ORG}/dist`. Every selected browser plugin must have a matching artifact
entry; unknown identities fail preparation. Preparation rejects duplicate
identities, missing entries, mismatched categories, incompatible host versions,
escaping paths or symlinks (including manifests), missing files, and SHA-256
mismatches before Next imports plugin bytes. Switching organisations clears
previous generated bundles, loaders, stylesheets, and public assets.

The Dashboard imports content-addressed files staged under
`lib/generated/browser-plugins`, never organisation package source. Plugin
updates require rebuilding and deploying that organisation environment. The
private Backend uses its own cloud-org artifact; the customer Console has no
organisation plugin host, manifest, or build input.

Anonymous embed routes can render form-component plugins without the
authenticated GraphQL provider. Their GraphQL requester rejects authenticated
operations; embed submission continues through the form-specific server
boundary. The `/public/form` layout loads analytics plugins only and excludes
form-component plugins.

## Contributor verification

`cli/pfcli/test/distribution-build.spec.ts` exercises the compiled CLI's empty,
PostHog, Google Drive, and Xero artifacts with isolated consumers. The
`private-consumer` distribution round trip builds from installed release
packages outside the workspace. Dashboard preparation tests exercise changing
projects/environments and reject manifests and files escaping their artifact.
Private Backend registration tests cover usage-cost rendering and access-review
downloads. These tests complement browser acceptance; registration alone does
not prove an authenticated Dashboard or public form journey.

## CI

`scripts/ci-frontend-build.sh` bootstraps a local org/auth/GraphQL environment
and then builds both distributions (`DASHBOARD_DISTRIBUTION=both` by default):

1. **generic** — organisation artifact, plugin/cloud credentials unset, `@pf/frontend:next-build`
2. **hosted** — cloud-org artifact plugins in the private Backend OpenNext build, followed by a separate Console OpenNext build whose output is scanned for those plugin identities and bundle hashes

After each build, CI checks the generated composition report and scans client
chunks so organisation plugin bundles do not include cloud backend, AWS SDK, CDK,
database, or job-worker code.
