# Public prerelease pipeline

The snapshot exporter installs this pipeline in the private staging repository.
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

`tools/public-release/policy.ts` defines the one fixed Nx Release group: exactly
the ten packages listed in #2483. Xero and pforg are outside this first release.
Nx configuration is added to the exported workspace, not the private repository's
release surface. The only accepted version is `0.1.0-next.0`, with public access
and the `next` tag. Source manifests already declare that initial version;
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

The manually dispatched `public-release.yml` runs only on trunk. Its preparation
job completes CI, builds and packs once, then uploads those bytes. The protected
job downloads the same run's artifact and performs `npm publish --dry-run` on
the tarballs. It does not check out source, install dependencies, rebuild, repack,
or execute package lifecycle scripts. There is no live publish option, GitHub
release operation, or visibility operation in this implementation.

Before a future, separately authorized publication:

1. Configure the `npm-next` GitHub environment with required human reviewers,
   prevent self-review, restrict deployments to protected `trunk`, and protect
   workflow/policy changes through branch review. Environments are external
   settings; merely naming one in YAML does not enable protection.
2. Complete legal/security/source-snapshot approvals and human npm bootstrap
   for all ten names. Do not place npm tokens in repository or environment
   secrets. Configure each npm trusted publisher for the final repository,
   `public-release.yml`, and environment `npm-next`.
3. Confirm the public source repository matches each manifest's `repository`.
   npm provenance requires public source; a private staging dry run cannot
   verify provenance issuance. Node 26 supplies an OIDC-capable npm; verify
   npm's supported version during bootstrap.
4. In a separately reviewed change, enable actual publication of these same
   reviewed tarballs with `--ignore-scripts --access public --tag next
   --provenance`. Retain the protected, isolated job's `id-token: write` and
   do not add credentials to PR/build jobs. Never promote `latest` here.

See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) and
[npm provenance requirements](https://docs.npmjs.com/generating-provenance-statements/).
