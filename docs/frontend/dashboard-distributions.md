# Dashboard Distributions

Process Focus builds one generic Dashboard using an organisation's artifact.

- **Dashboard** is the organisation application in `apps/frontend`.
- **Backend** is the operator deployment of that Dashboard, using the cloud-org
  organisation.
- **Console** is the separate customer hosting application in `cloud/org/console`.

Organisation artifacts supply browser plugins, executable form schemas, and
public assets. Frontend preparation validates and stages them before building
Next.js. Plugin and form changes therefore require rebuilding the Dashboard.

For build-input changes, `@pf/frontend:prepare-build-inputs` validates
`browser-plugins.json` and stages literal imports/content-addressed bundles,
the combined manifest, docs, icons and public-form branding. Local Next and
hosted OpenNext consume that contract. The manifest store resolves relative
`PF_ORG` against `PF_RUNTIME_ROOT` when set, otherwise the frontend runtime root.

Keep public manifest values separate from server/build inputs (`PF_ORG`,
`PF_ENV`, `GRAPHQL_ENDPOINT`, `JWKS_URI`, `FRONTEND_JWT_TOKEN`). An org opting
into the shared PostHog path needs `POSTHOG_PROJECT_API_KEY` and `POSTHOG_HOST`
during `pfcli build`; missing values fail before frontend preparation.
For embed environment/origin changes follow
[the embed build contract](../agents/embedded-forms.md#environment-selection-and-rebuilds).

The installed local runtime builds under `.processfocus/dashboard/`. Hosted
deployments package the Dashboard with OpenNext. The Backend supplies its own
organisation plugins; Console does not host customer plugins.

See [local runtime setup](../../runtime/local/README.md) for development and
consumer builds.
