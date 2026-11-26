# Public Prereleases

Canonical development happens in the private monorepo. The public repository
receives a one-way source export, and published packages correspond to that
exported revision.

Public CI checks the standalone workspace and packed consumers without private
repository credentials. The release policy defines the package group, version,
and `next` tag.

The public prerelease workflow has three modes:

- **verify-oidc:** Check npm trusted-publisher authentication without publishing.
- **rehearse:** Build and verify artifacts, then dry-run publication.
- **publish:** Publish the approved run's verified tarballs with provenance.

Review the source revision and release artifact before approving the `npm-next`
environment. Publishing consumes those artifacts without checking out source or
rebuilding in the privileged job. Existing versions or failed registry checks
stop publication.

Repository environment protection and npm trusted-publisher configuration are
maintained outside the workflow. Publishing stable releases is a separate policy
change.

See the [release policy](../tools/public-release/policy.ts) and
[workflow](../.github/workflows/public-release.yml).
