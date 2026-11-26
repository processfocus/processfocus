# @pf/auth-api

Connects the OAuth engine in [`@pf/openauth`](../openauth/README.md) to
Process Focus identities. It supports provider sign-in, passkeys, machine
credentials, and workload token exchange, and maps them to shared
[`@pf/auth-session`](../auth-session/README.md) sessions.

Local and hosted runtimes use this package to compose their authentication
server. Provider and client configuration comes from
[`@pf/auth-config`](../auth-config/README.md); database adapters supply identity
and credential storage.

Authentication establishes identity. Protected application boundaries evaluate
Cedar policy before granting access. Delegation management is hosted by the
GraphQL runtime; the issuer handles credential exchange and token issuance.

## Further reading

- [Sign-in flow and Google setup](./AUTHENTICATION-FLOW.md)
- [Live role authority](../../docs/authentication/role-authority.md)
- [Delegated access](../../docs/authentication/delegated-access.md)
- [Issuer and authorization boundaries](../../docs/adr/0037-issuers-validate-credentials-protected-boundaries-authorize.md)
