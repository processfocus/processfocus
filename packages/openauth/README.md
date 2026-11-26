# @pf/openauth

The Process Focus fork of [OpenAuth](https://github.com/sst/openauth), adapted
to Effect. It provides the OAuth/OIDC server and client engine, including
provider integration, passkeys, token issuance, refresh, and verification.

[`@pf/auth-api`](../auth-api/README.md) connects this engine to Process Focus
identities and configuration.

## Integration

Register clients with their exact allowed redirect URIs. OAuth endpoints live
under `/oauth/`; discovery and signing keys are exposed under `/.well-known/`.
Clients can use discovery rather than construct endpoint URLs.

The [issuer](./src/issuer.ts) and [client](./src/client.ts) define supported
options and flows. Session subject schemas belong to
[`@pf/auth-session`](../auth-session/README.md).
