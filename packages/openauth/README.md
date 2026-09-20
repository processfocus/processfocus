# About

Copy of [openauth](https://github.com/sst/openauth) as it seems to be
in a maintenance crisis.

Other reasons:
- [X] We wanted to use Bun for serving requests, not hono.
- [X] We want to replace valibot with Effect.
- [X] We want to address security concerns.
- [ ] We want passkey support.

# Server and client

The package contains both client and server. Teasing them apart is
complicated, due to mutual dependencies, especially in tests.

# JWT

A JWT as returned by this server:

```json
{
  "mode": "access",
  "type": "employee",
  "properties": {
    "employeeID": "e-01K9V5Z1SJVRE2ZW8XAH60CRHX",
    "orgID": "ou-01K9BWZA89QND5YT7VXBEFMYTP"
  },
  "aud": "graphql-api",
  "iss": "http://localhost:4020",
  "sub": "employee:1f70159ab9ba5793",
  "exp": 1765681819
}
```

# Client registration

Set the `clients` option (or the `OPENAUTH_CLIENTS` environment variable) when
creating an issuer. Every client must declare the exact redirect URIs it is
allowed to use, plus an optional secret for confidential flows.

```ts
const auth = issuer({
  clients: [
    {
      id: "web-client",
      redirectUris: [
        "https://app.example.com/oauth/callback",
        "http://localhost:3000/oauth/callback",
      ],
      secret: process.env.WEB_CLIENT_SECRET,
    },
  ],
  // ...storage, subjects, providers
})
```

When posting to `/oauth/token` with both an OAuth client identity and a provider
credential, send your OAuth client identifier in the `oauth_client_id` field.
This leaves the standard `client_id`/`client_secret` pair available for the
underlying provider (for example, when using the `client_credentials` grant).

- `oauth_client_id` identifies the application registered with OpenAuth. It
  selects the redirect allowlist, PKCE requirements, token audience, and the
  secret (if any) used to authenticate to the issuer itself.
- `client_id` / `client_secret` are forwarded to the upstream provider
  implementation (e.g., a backend you proxy via `providers.dummy.client`). They
  should remain whatever that upstream service expects.

Keeping these namespaces separate lets a confidential OAuth client call
`/oauth/token` securely while still presenting different credentials to the
provider it integrates with.

# Token response

The token endpoint returns `access_token`, `refresh_token`, `expires_in`, and
an extension parameter `refresh_expires_in`:

```json
{
  "access_token": "eyJhbGciOiJFUzI1NiIs...",
  "refresh_token": "employee:abc123:uuid",
  "expires_in": 3600,
  "refresh_expires_in": 7776000
}
```

## refresh_expires_in (extension)

The `refresh_expires_in` parameter is a non-standard extension to OAuth 2.1.
The OAuth 2.1 spec explicitly states that "there is no property defined to
communicate the expiration of a refresh token to the client" because the client
can't do anything useful with this information beyond starting a new flow when
the token expires.

However, for clients that need to set cookie expiration times appropriately
(e.g., web applications), knowing the refresh token lifetime is practical. This
extension follows the pattern used by other implementations like Keycloak.

The value is the refresh token lifetime in seconds.

# Token TTL configuration

Configure token lifetimes via the `ttl` option:

```ts
const auth = issuer({
  ttl: {
    access: 60 * 60,           // 1 hour (default)
    refresh: 60 * 60 * 24 * 90, // 90 days
  },
  // ...
})
```
