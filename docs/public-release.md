# Public prerelease pipeline

The snapshot exporter installs this pipeline in the public source mirror.
The private monorepo does not run these workflows. Public CI uses `pull_request`
(including fork merge trees), read-only permissions, no credentials persisted
by checkout, no Nx Cloud, and no secrets. Every run installs the frozen lockfile
and checks all projects, rather than relying on private base history or caches.

`public-source.yml` runs Biome, Nx lint/typecheck/test/build/Knip, project boundary
guards, tracked-file credential detection, canonical package license checks,
packed manifest checks, and independent installed-consumer tests. Credential
patterns are a regression guard, not a replacement for security review.
Third-party dependency license approval remains a human review of the retained
dependency closure; the automatic license check covers first-party packages.

`tools/public-release/policy.ts` defines the one fixed Nx Release group:
`RELEASE_PACKAGES`. #2483 started with ten packages. `@processfocus/pforg` and
`@processfocus/plugin-xero` joined that group for `0.1.0-next.1`.
Nx configuration is added to the exported workspace, not the private repository's
release surface. The only accepted version is `RELEASE_VERSION`, with public access
and the `next` tag. Source manifests declare that same version;
Nx Release plans it without writing versions, Git tags, commits, or changelogs.
Existing pack targets rewrite workspace dependencies and inspect their output.
The release guard checks every internal runtime/peer/optional dependency against
the fixed group and exact version, rejecting any unpublished dependency.

For a local rehearsal in a fresh, clean exported clone (preparation rejects
uncommitted inputs and source changes made by verification):

```sh
bun install --frozen-lockfile
bun scripts/check-public-source.ts
bun scripts/public-release.ts dist/public-release
```

Review the `public-release-<commit>` Actions artifact before approving the
`npm-next` environment. It retains tarballs, manifests, file lists with modes
and SHA-256 checksums, canonical licenses, Nx's version plan, consumer lockfile,
dependency closure, and consumer execution evidence. `SHA256SUMS` covers all
review files. Compare the immutable Actions artifact digest and source commit
with the run you reviewed; checksums alone do not authenticate a producer.

The manually dispatched `public-release.yml` runs only on the public mirror's
protected trunk, with three modes:

- `verify-oidc` (default): after environment approval, verify npm accepts the
  GitHub OIDC identity for each package. Tokens stay in memory and are never
  logged, persisted, or used to publish. This verifies authentication, not
  successful package publication or provenance generation.
- `rehearse`: complete CI, build and pack once, then download the same run's
  artifact in the approved job and perform `npm publish --dry-run`.
- `publish`: build and pack on that run, reject the entire group before publishing
  if any version already exists or its registry lookup fails, then publish that
  run's tarballs with `--ignore-scripts --access public --tag next --provenance`.
  It does not reuse an earlier rehearse artifact.

Neither privileged job checks out source, installs dependencies, rebuilds,
repacks, or executes package lifecycle scripts. There is no GitHub release or
repository visibility operation. The initial `0.1.0-next.0` versions have already
been bootstrapped; another publication requires a reviewed version bump in the
fixed-group policy and source manifests. Do not republish the initial group to
test OIDC; use `verify-oidc` instead.

Before a future, separately authorized publication:

1. Configure the `npm-next` GitHub environment with required human reviewers,
   restrict deployments to protected `trunk`, and protect
   workflow/policy changes through branch review. Environments are external
   settings; merely naming one in YAML does not enable protection. The owner
   explicitly approved self-review for the current single-maintainer setup:
   Berend may approve a manually dispatched run that he started. Required
   environment approval remains enabled; no administrator bypass is needed.
2. Complete legal/security/source-snapshot approvals and human npm bootstrap
   for every name in `RELEASE_PACKAGES`. A name that is not yet on npm cannot
   receive a trusted publisher, and the publish job refuses the whole group
   before uploading any tarball. Do not place npm tokens in repository or
   environment secrets. Configure each npm trusted publisher for the final
   repository, `public-release.yml`, and environment `npm-next`.
3. Confirm the public source repository matches each manifest's `repository`.
   npm provenance requires public source; a private staging dry run cannot
   verify provenance issuance. Node 26 supplies an OIDC-capable npm; verify
   npm's supported version during bootstrap.
4. Select `publish` only for an approved new version and approve the exact
   artifact in the environment gate. Retain the isolated job's `id-token: write`
   and do not add credentials to PR/build jobs. After verifying OIDC exchanges,
   restrict token publishing and revoke the bootstrap login credential.

The initial manual publications do not have GitHub OIDC provenance. npm created
`latest` alongside `next` for the first versions despite explicit `--tag next`
and rejected authenticated removal with HTTP 400. The owner accepted this
bootstrap exception in #2495. Subsequent prereleases must keep using `next`
without moving the existing `latest` tag unless separately approved.

See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) and
[npm provenance requirements](https://docs.npmjs.com/generating-provenance-statements/).
