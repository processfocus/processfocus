# About

Provides Cedar authorisation policies and utilities.

## Key Files

- `cedar/schema.cedarschema` - Cedar entity/action schema
- `cedar/policies.cedar` - Base policies (employee GraphQL access, execution viewing)
- `src/lib/types.ts` - TypeScript types for principals and resources

## Delegation Issuance And Owner Listing

`AuthorizationService` exports these checks, both requiring `RequestTime`:

```ts
auth.canIssueDelegationSecret(principal, owner, {
  ownerProviderUserId: ownerRow.id,
  humanSession: verifiedSession.humanSession === true,
  humanAuthentication: verifiedSession.humanAuthentication,
})
auth.canListDelegationTokens(principal, owner)
```

`principal` is the authenticated actor; `owner` is a `ProviderUserPrincipal`
constructed from the database-resolved owner's **email**, roles, and org unit.
The separate `ownerProviderUserId` is that same owner's database ID, not email.
`DelegationIssuanceContext` is exported from `@pf/auth-policy`.

Only pass evidence from a signature-verified session, never request JSON,
decoded-but-unverified JWT properties, access-token `iat`, or the time of refresh.
The optional signed `humanAuthentication` claim has `providerUserId`,
`authenticatedAt` (epoch milliseconds), and `method: "passkey"`. Passkey
authentication establishes it after verified user verification; registration,
federated identity alone, and M2M issuance do not establish it. Refresh and CLI
export preserve its original timestamp rather than renewing it.

Cedar actions are `PF::Action::"issueDelegationSecret"` and
`PF::Action::"listDelegationTokens"`, with the owner ProviderUser as resource.
Issuance context includes `ownerProviderUserId` and optional
`humanAuthentication: { providerUserId, method, ageMillis }`. The Cedar adapter
derives age from server `RequestTime` using epoch arithmetic, independently of
the existing wall-clock `context.requestTime` encoding.

Shared policy grants neither own-token listing nor issuance. Organisations add
`listDelegationTokens` and `issueDelegationSecret` permits independently, so a
particular user or organisation role can receive either capability without the
other. The issuer and Dashboard do not hard-code Administrator checks.

The demo grants each action to same-owner human Administrators.
Its issuance policies require a Provider User principal equal to the owner and
trusted human-session provenance. The issuer signs `humanSession: true` after
OAuth human login or passkey login/registration. M2M `email:` impersonation and
Delegated Sessions never establish this marker. It is not proof of MFA or fresh
authentication. Refresh, role switching, and CLI export preserve it; they cannot
upgrade an unmarked session to a human session. Cedar receives `humanSession` as
a boolean derived only from the signature-verified session.

For legacy passkey sessions, same-owner signed passkey evidence identifies human
provenance without imposing an age condition. Legacy Google sessions have neither
marker nor passkey evidence and cannot be distinguished from M2M impersonation;
they must sign in once again before satisfying a human-only issuance grant. Do not infer human provenance
from the owner's configured provider, JWT audience, request JSON, or token age.

A valid marked Google session without `humanAuthentication`, or a valid marked
passkey session with old evidence, can create and replace its own secrets without
reauthentication when organisation policy permits. Delegated issuance requires an
explicit organisation permit and remains limited to the Delegation's represented
Provider User. Shared `forbid` policies make cross-owner creation and replacement
non-overridable for human and Delegation principals. The owner resource and the
Delegation's owner relationship must come from authoritative backend state, not a
caller identity claim. Organisation enablement, supported credential types, and
later delegation lineage/validity invariants remain the caller's responsibility.

For example, a particular user's list-only grant is independent of issuance:

```cedar
permit (
    principal == PF::ProviderUser::"alice@example.com",
    action == PF::Action::"listDelegationTokens",
    resource == PF::ProviderUser::"alice@example.com"
);
```

Organisations can opt into the previous same-owner fresh-passkey requirement by
adding this **forbid** to their custom Cedar policies. An additional restrictive
permit alone cannot narrow an organisation permit; Cedar permits are additive.

```cedar
forbid (
    principal is PF::ProviderUser,
    action == PF::Action::"issueDelegationSecret",
    resource is PF::ProviderUser
)
unless {
    principal != resource ||
    (
        context has humanAuthentication &&
        context.humanAuthentication.providerUserId == context.ownerProviderUserId &&
        context.humanAuthentication.method == "passkey" &&
        context.humanAuthentication.ageMillis >= 0 &&
        context.humanAuthentication.ageMillis <= 300000
    )
};
```

This example adds a freshness requirement to human self-issuance. Cross-owner
minting is independently denied by the shipped ownership forbids, while an
explicit same-owner delegated grant remains outside this freshness forbid. The
issuer checks actual trusted evidence first.
If a fresh same-owner passkey would satisfy policy, passkey users can complete
the supported verification flow; Google-only users receive
`unsupported_authentication`. Missing, stale, future-dated, or wrong-owner evidence
cannot satisfy this stricter policy. Refresh and CLI export never renew evidence.

## Policy Examples

Allow someone with the "Employee" to start all processes:

```cedar
permit (
    principal in PF::Role::"Employee",
    action == PF::Action::"start",
    resource is PF::Process
);
```

Allow the same role to complete all steps:

```cedar
permit (
    principal in PF::Role::"Employee",
    action == PF::Action::"complete",
    resource is PF::Step
);
```

Allow an employee to approve purchase requests:

```cedar
permit (
    principal == PF::Employee::"john@example.com",
    action == PF::Action::"complete",
    resource == PF::Step::"finance/purchase-request/Manager approval"
);
```

Allow an employee to complete all tasks for the purchase request process:

```cedar
permit (
    principal == PF::Employee::"john@example.com",
    action == PF::Action::"complete",
    resource in PF::Process::"finance/purchase-request"
);
```

Forbid an employee to approve a time-off request:

```cedar
forbid (
    principal == PF::Employee::"john@example.com",
    action == PF::Action::"complete",
    resource == PF::Step::"hr/time-off-request/Approve time off"
);
```

## GraphQL Field Authorization

All GraphQL Query/Mutation/Subscription fields require Cedar authorization. The base
policy in `cedar/policies.cedar` allows employees with roles to access fields without
a tag or with `tag: "employee"`.

**Base policy** (in `cedar/policies.cedar`):
```cedar
permit (
    principal is PF::Employee,
    action in [PF::Action::"query", PF::Action::"mutation", PF::Action::"subscription"],
    resource is PF::GraphQLField
)
when {
    principal.roles.isEmpty() == false &&
    (!(resource has tag) || resource.tag == "employee")
};
```

**Custom policies** can restrict or extend access. For example, in your organisation's
Cedar policy file:

```cedar
// Allow service accounts to access CI-tagged fields (for test automation)
permit (
    principal is PF::ServiceAccount,
    action in [PF::Action::"query", PF::Action::"mutation"],
    resource is PF::GraphQLField
)
when { resource.tag == "ci" };

// Restrict a specific field to managers only
permit (
    principal is PF::Employee,
    action == PF::Action::"mutation",
    resource == PF::GraphQLField::"Mutation.approveExpense"
)
when { principal.roles.contains(PF::Role::"manager") };
```

**Usage in GraphQL schema** (optional `@auth` directive for tagged fields):

```graphql
type Query {
  currentEmployee: Employee!           # No tag - accessible to employees with roles
  processes: [Process!]!               # No tag - accessible to employees with roles
}

type Mutation {
  requestRole(rolePath: String!): RequestRoleResult!  # No tag - default access
  cleanupExecutions: CleanupResult! @auth(tag: "ci") # Restricted to CI service accounts
}
```

## List Authorization

Lists have role-based authorization via the `view` action. The base policy allows
employees to access a list if they have one of the list's allowed roles. The
`roles` attribute is a set of entity references (not strings).

**Base policy** (in `cedar/policies.cedar`):
```cedar
permit (
    principal is PF::Employee,
    action == PF::Action::"view",
    resource is PF::List
)
when {
    principal.roles.containsAny(resource.roles)
};
```

**Example custom policies**:

Allow employees to access lists designated for a different role:
```cedar
permit (
    principal in PF::Role::"/Employee",
    action == PF::Action::"view",
    resource is PF::List
)
when {
    resource.roles.contains(PF::Role::"/Customer")
};
```

Note: `resource.roles` contains entity references, so compare with
`PF::Role::"..."`, not plain strings.

## Context-based policies

All authorization requests include a `context` with:
- `requestTime` - Cedar `datetime` of the request in server's local timezone
- `nodeEnv` - Environment string (e.g., "development", "production")

Only allow login during business hours (9:00-17:00) in production:

```cedar
permit (
    principal is PF::Employee,
    action == PF::Action::"login",
    resource is PF::Application
)
when {
    principal.roles.isEmpty() == false &&
    (context.nodeEnv != "production" ||
     (context.requestTime.toTime() >= duration("9h") &&
      context.requestTime.toTime() < duration("17h")))
};
```

Only allow completing steps in development environment:

```cedar
permit (
    principal is PF::Employee,
    action == PF::Action::"complete",
    resource is PF::Step
)
when {
    principal.roles.contains(resource.role) &&
    context.nodeEnv == "development"
};
```

## File Download Authorization

Files have file-level authorization via the `download` action. The base system policy allows file owners to download their own files. Custom policies can add additional permits for org-unit sharing, document-store based access, or role-based access.

**File entity attributes**:
- `owner` - Employee who uploaded the file (entity reference)
- `documentStore` - Document store path (e.g., "/finance/documents")

**Base policy** (in `cedar/policies.cedar`):
```cedar
// File owners can download their own files.
permit (
    principal is PF::Employee,
    action == PF::Action::"download",
    resource is PF::File
)
when {
    principal == resource.owner
};
```

**Example custom policies**:

Allow employees to download files from their org unit:
```cedar
permit (
    principal is PF::Employee,
    action == PF::Action::"download",
    resource is PF::File
)
when {
    resource in principal.orgUnit
};
```

Allow downloads from public document stores:
```cedar
permit (
    principal is PF::Employee,
    action == PF::Action::"download",
    resource is PF::File
)
when {
    resource.documentStore == "/public/docs"
};
```

Allow managers to download from confidential stores:
```cedar
permit (
    principal in PF::Role::"manager",
    action == PF::Action::"download",
    resource is PF::File
)
when {
    resource.documentStore == "/confidential/manager"
};
```

**Explicit forbid** (default in `cloud/org/cedar/custom.cedar`):
```cedar
// Only the file owner can download files.
forbid (
    principal is PF::Employee,
    action == PF::Action::"download",
    resource is PF::File
)
unless {
    principal == resource.owner
};
```

Note: `forbid` policies override `permit` policies, so to allow additional access you must add `permit` policies in your custom Cedar file.

## Entities example

```json
[
  {
    "uid": { "type": "PF::Role", "id": "clerk" },
    "attrs": {},
    "parents": [
      { "type": "PF::OrgUnit", "id": "finance" }
    ]
  },
  {
    "uid": { "type": "PF::Role", "id": "manager" },
    "attrs": {},
    "parents": [
      { "type": "PF::OrgUnit", "id": "finance" }
    ]
  },
  {
    "uid": { "type": "PF::OrgUnit", "id": "finance" },
    "attrs": { "name": "Finance Department" },
    "parents": []
  },
  {
    "uid": { "type": "PF::OrgUnit", "id": "hr" },
    "attrs": { "name": "Human Resources" },
    "parents": []
  },
  {
    "uid": { "type": "PF::Role", "id": "hr-clerk" },
    "attrs": {},
    "parents": [
      { "type": "PF::OrgUnit", "id": "hr" }
    ]
  },
  {
    "uid": { "type": "PF::Role", "id": "hr-manager" },
    "attrs": {},
    "parents": [
      { "type": "PF::OrgUnit", "id": "hr" }
    ]
  },
  {
    "uid": { "type": "PF::Employee", "id": "carol" },
    "attrs": {
      "name": "Carol White",
      "roles": [{ "type": "PF::Role", "id": "hr-clerk" }]
    },
    "parents": [
      { "type": "PF::OrgUnit", "id": "hr" }
    ]
  },
  {
    "uid": { "type": "PF::Employee", "id": "dave" },
    "attrs": {
      "name": "Dave Miller",
      "roles": [{ "type": "PF::Role", "id": "hr-manager" }]
    },
    "parents": [
      { "type": "PF::OrgUnit", "id": "hr" }
    ]
  },
  {
    "uid": { "type": "PF::Process", "id": "onboarding" },
    "attrs": {
      "name": "Employee Onboarding",
      "startRoles": [
        { "type": "PF::Role", "id": "hr-clerk" },
        { "type": "PF::Role", "id": "hr-manager" }
      ]
    },
    "parents": [
      { "type": "PF::OrgUnit", "id": "hr" }
    ]
  },
  {
    "uid": { "type": "PF::Employee", "id": "alice" },
    "attrs": {
      "name": "Alice Smith",
      "roles": [{ "type": "PF::Role", "id": "clerk" }]
    },
    "parents": [
      { "type": "PF::OrgUnit", "id": "finance" }
    ]
  },
  {
    "uid": { "type": "PF::Employee", "id": "bob" },
    "attrs": {
      "name": "Bob Jones",
      "roles": [{ "type": "PF::Role", "id": "manager" }]
    },
    "parents": [
      { "type": "PF::OrgUnit", "id": "finance" }
    ]
  },
  {
    "uid": { "type": "PF::Step", "id": "expense-submit" },
    "attrs": {
      "name": "Submit Expense",
      "requiredRole": { "type": "PF::Role", "id": "clerk" }
    },
    "parents": []
  },
  {
    "uid": { "type": "PF::Process", "id": "expense-report" },
    "attrs": {
      "name": "Expense Report",
      "startRoles": [
        { "type": "PF::Role", "id": "clerk" }
      ]
    },
    "parents": [
      { "type": "PF::OrgUnit", "id": "finance" }
    ]
  },
  {
    "uid": { "type": "PF::Application", "id": "pf-app" },
    "attrs": {},
    "parents": []
  },
  {
    "uid": { "type": "PF::Employee", "id": "eve" },
    "attrs": {
      "name": "Eve Nobody",
      "roles": []
    },
    "parents": [
      { "type": "PF::OrgUnit", "id": "finance" }
    ]
  },
  {
    "uid": { "type": "PF::File", "id": "file-123" },
    "attrs": {
      "owner": { "type": "PF::Employee", "id": "alice" },
      "documentStore": "/finance/documents"
    },
    "parents": [
      { "type": "PF::OrgUnit", "id": "finance" }
    ]
  },
  {
    "uid": { "type": "PF::File", "id": "file-456" },
    "attrs": {
      "owner": { "type": "PF::Employee", "id": "bob" },
      "documentStore": "/public/docs"
    },
    "parents": [
      { "type": "PF::OrgUnit", "id": "hr" }
    ]
  }
]
```
