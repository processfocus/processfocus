# OAuth 2.1 Compliance Analysis

Analysis of `packages/openauth` against draft-ietf-oauth-v2-1-14 and RFC 9700 (Security BCP).

## Summary

The openauth implementation is **largely compliant** with OAuth 2.1. Key strengths include mandatory PKCE for public clients, removal of implicit grant, comprehensive security headers, and RFC 7519 compliant JWT validation. A few areas need attention, primarily around authorization server metadata completeness and scope support.

---

## MUST Requirements

### Authorization Code Grant (Section 4.1)

- [x] Only `response_type=code` supported (implicit grant removed)
- [x] Authorization codes expire shortly after issuance (60 seconds TTL)
- [x] Authorization codes are single-use (removed from storage after exchange)
- [x] Code bound to client_id and redirect_uri
- [x] Validates redirect_uri at token endpoint matches authorization request

### PKCE (Section 4.1.1, 7.5.2)

- [x] Authorization servers MUST support code_challenge/code_verifier
- [x] S256 method is mandatory to implement
- [x] Public clients MUST use PKCE (`issuer.ts:1340-1345`)
- [x] Reject `code_challenge_method` other than S256 (`issuer.ts:1333-1338`)
- [x] Verify code_verifier at token endpoint
- [x] PKCE validation uses timing-safe comparison (`pkce.ts:39` uses `timingSafeCompare`)

### Token Endpoint (Section 3.2)

- [x] MUST use POST method
- [x] Requires `application/x-www-form-urlencoded` content type
- [x] Confidential clients MUST authenticate
- [x] Returns `access_token`, `token_type`, `expires_in`
- [x] Cache-Control: no-store header on responses (via CSP headers)
- [x] Ignore unrecognized request parameters

### Client Authentication (Section 2.4)

- [x] Supports `client_secret_basic` (HTTP Basic)
- [x] Supports `client_secret_post` (form body)
- [x] Supports `none` for public clients
- [x] Timing-safe secret comparison (`random.ts:16-24`)
- [x] Client MUST NOT use more than one auth method per request

### Redirect URI (Section 2.3)

- [x] Exact string matching required (`issuer.ts:560-571`)
- [x] Fragment component prohibited (`normalizeRedirectUri`)
- [x] HTTPS/HTTP schemes only
- [x] Multiple redirect URIs supported per client
- [x] Registration of complete redirect URIs required

### Refresh Tokens (Section 4.3)

- [x] Bound to client that received them
- [x] Scope cannot exceed original grant
- [x] Rotation on use with reuse detection (`issuer.ts:1181-1203`)
- [x] Invalidate all tokens on suspicious reuse
- [x] Configurable reuse window (`ttl.reuse`)

### Access Tokens (Section 1.4)

- [x] JWT format with signature (ES256)
- [x] Includes `iss`, `sub`, `aud`, `exp` claims
- [x] Short-lived (configurable, default 1 hour)
- [x] Scoped to client (audience validated per RFC 7519 §4.1.3)

### Token revocation

- [x] Token Revocation endpoint (RFC 7009) - Implemented at `/oauth/revoke`

### Transport Security (Section 1.5)

- [x] HTTPS required for all endpoints (except loopback)
- [x] Cookie secure flag set when HTTPS (`issuer.ts:782-784`)
- [x] HttpOnly cookies for authorization state

---

## MUST NOT Requirements

- [x] MUST NOT use implicit grant (`response_type=token`) - Not implemented
- [x] MUST NOT use Resource Owner Password Credentials grant - Not implemented
- [x] MUST NOT pass bearer tokens in URI query strings - Only Authorization header/form body
- [x] MUST NOT include fragments in redirect URIs - Validated and rejected
- [x] MUST NOT automatically redirect on invalid redirect_uri - Returns error response
- [x] MUST NOT use HTTP 307 for redirects with credentials - Uses 302

---

## SHOULD/RECOMMENDED Requirements

### Implemented

- [x] Use asymmetric client authentication methods (supports JWT/mTLS ready)
- [x] Issue short-lived access tokens (configurable)
- [x] Sender-constrained refresh tokens via rotation
- [x] Clickjacking protection via X-Frame-Options and CSP
- [x] Security headers on all responses
- [x] Validate TLS certificates (platform default)

### Not Yet Implemented

- [ ] Token Introspection endpoint (RFC 7662)
- [ ] Token Revocation endpoint (RFC 7009) improvements:
  - [ ] Missing `token_type_hint` parameter (RFC 7009 Section 2.1) RFC
        7009 Section 2.1 specifies an optional token_type_hint
        parameter to help the server optimize token lookup.
  - [ ] Missing client authentication for confidential clients (RFC
        7009 Section 2.1) RFC 7009 Section 2.1 states clients MUST
        authenticate if they are confidential clients. Current
        implementation at issuer.ts:1456-1479 has no authentication
        mechanism.
  - [ ] Missing `unsupported_token_type` error response (RFC 7009
        Section 2.2.1).  RFC 7009 Section 2.2.1 requires returning
        this error when the server does not support revoking the
        presented token type.
- [ ] DPoP support (RFC 9449) for sender-constrained access tokens
- [ ] Mutual TLS (RFC 8705) client authentication

---

## Security Considerations

### Implemented

- [x] CSRF protection via PKCE code_challenge
- [x] Timing-safe client secret comparison
- [x] Authorization code injection prevention via PKCE
- [x] Refresh token replay detection
- [x] Encrypted authorization state cookies (RSA-OAEP-512)
- [x] Security headers: X-Content-Type-Options, X-Frame-Options, CSP, Referrer-Policy
- [x] Content-Type enforcement on token endpoint
- [x] JWT audience (`aud`) validation per RFC 7519 §4.1.3 - prevents token mix-up attacks

### Needs Attention

- [ ] **No scope parameter support** - Scopes not validated or enforced

- [x] **Token revocation invalidates only the specific token** - Now correctly revokes only the specific refresh token per RFC 7009, not all sessions (`issuer.ts:1478-1481`)

---

## Recommendations for Future Improvements

### Medium Priority

4. **Add `iss` parameter to authorization response** per RFC 9207 for mix-up attack prevention

5. **Add scope support** - Currently no scopes are validated or issued

### Low Priority

7. **Consider DPoP support** (RFC 9449) for proof-of-possession tokens

8. **Add Token Introspection** (RFC 7662) for resource server validation

9. **Private-use URI scheme validation** for native app redirect URIs (reverse domain check)

---

## Extensions Beyond OAuth 2.1

### refresh_expires_in

The token response includes an additional `refresh_expires_in` parameter that
communicates the refresh token lifetime in seconds. This is **not part of OAuth
2.1** - the spec explicitly states "there is no property defined to communicate
the expiration of a refresh token to the client".

We added this extension because:
- Web clients need to set appropriate cookie expiration times
- Other implementations (Keycloak) provide similar functionality
- OAuth 2.1 allows additional response parameters (clients MUST ignore unrecognized parameters)

---

## Files Reviewed

| File | Purpose |
|------|---------|
| `src/issuer.ts` | Main OAuth server implementation |
| `src/pkce.ts` | PKCE generation and validation |
| `src/error.ts` | OAuth error types |
| `src/router.ts` | HTTP router with security headers |
| `src/random.ts` | Timing-safe comparison utilities |
| `src/keys.ts` | Signing and encryption key management |
| `src/cookies.ts` | Secure cookie handling |

---

## Specification References

- [draft-ietf-oauth-v2-1-14](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1) - OAuth 2.1 (main spec)
- [RFC 9700](https://www.rfc-editor.org/rfc/rfc9700) - OAuth Security BCP
- [RFC 7519](https://www.rfc-editor.org/rfc/rfc7519) - JSON Web Token (JWT)
- [RFC 7636](https://www.rfc-editor.org/rfc/rfc7636) - PKCE
- [RFC 9207](https://www.rfc-editor.org/rfc/rfc9207) - Authorization Server Issuer Identification
- [RFC 8414](https://www.rfc-editor.org/rfc/rfc8414) - Authorization Server Metadata

---

## RFC 7519 (JSON Web Token) Compliance

Analysis against RFC 7519 requirements for JWT creation and validation.

### MUST Requirements

#### JWT Creation (Section 7.1)

- [x] JWT conforms to JWS specification (signed with ES256)
- [x] All JWS creation steps followed (via jose library)

#### JWT Validation (Section 7.2)

- [x] Reject JWT if any validation step fails
- [x] Verify JWT contains period characters
- [x] Base64url decode header and payload
- [x] Verify JSON structure validity
- [x] Verify supported algorithms only (ES256)

#### Claims (Section 4)

- [x] Claim names are unique in JWT claims set
- [x] **`iss` (Issuer)**: Present and validated (`issuer.ts:881`, `client.ts:824`)
- [x] **`sub` (Subject)**: Locally unique within issuer context (`issuer.ts:882`, format: `{type}:{hash}`)
- [x] **`aud` (Audience)**: Present and validated - rejects if principal not in audience (`issuer.ts:880`, `client.ts:825`)
- [x] **`exp` (Expiration)**: Present and validated - rejects expired tokens (`issuer.ts:884`, jose automatic)

#### Optional Claims (Not Implemented)

- [ ] **`iat` (Issued At)**: Not explicitly set (jose may auto-include)
- [ ] **`nbf` (Not Before)**: Not used - tokens valid immediately
- [ ] **`jti` (JWT ID)**: Not used - see note on replay protection

**Note on `jti`**: Replay protection is handled via refresh token rotation instead of JWT ID tracking. Comment at `issuer.ts:860` acknowledges `jti` could be added for access token replay detection.

### Algorithm Support (Section 8)

- [ ] HS256 (HMAC SHA-256) - Not implemented
- [x] ES256 (ECDSA P-256) - Primary signing algorithm (`keys.ts:13`)
- [x] "none" algorithm rejected (only ES256 accepted)

**Note**: RFC 7519 requires HS256 for minimal conformance, but production deployments commonly use only asymmetric algorithms (ES256/RS256) for security. Our implementation intentionally omits HS256.

### Security Considerations (Section 10)

- [x] Cryptographic strength: ES256 with generated keys (`keys.ts:70-106`)
- [x] Key management: Automatic rotation with expiry tracking
- [x] Algorithm verification: Only ES256 accepted, "none" rejected
- [x] Audience restriction: Tokens bound to specific client (prevents token mix-up attacks)
- [x] Issuer verification: Tokens validated against expected issuer

### Recent Fixes

- **Commit 53e311a**: Added JWT audience validation to `client.verify()` and `/userinfo` endpoint, preventing token mix-up attacks where a token issued for one client could be used by another.
