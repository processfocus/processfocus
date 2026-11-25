# Sign-in flow

The frontend, authentication server, and identity provider have distinct roles:

1. The frontend starts sign-in and redirects the browser to the authentication
   server.
2. The authentication server sends the user to their chosen identity provider.
3. After sign-in, it resolves the Process Focus Provider User and any applicable
   invitation, then returns a Process Focus authorization code to the frontend.
4. The frontend exchanges the code for tokens and checks application admission
   before establishing the browser session.

The authentication server issues credentials; Cedar policy at the protected
application boundary decides whether the user may enter and act.

## Google setup

Google's authorized redirect URI must point to the authentication server:
`<AUTH_SERVER_URL>/oauth/google/callback`. In local development, check
`.auth-port.json` for the current port.

Google Workspace organisational-unit invitations additionally require the Admin
SDK API, a service account with domain-wide delegation, and an administrator
who can read users. Grant the
`https://www.googleapis.com/auth/admin.directory.user.readonly` scope and supply
the corresponding provider configuration in
[`@pf/auth-config`](../auth-config/README.md).

A redirect mismatch usually means the configured callback differs from the
running server. Directory lookup failures concern Workspace permissions or
configuration; successful Google sign-in alone does not satisfy an invitation
requirement.
