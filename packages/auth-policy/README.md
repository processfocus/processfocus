# @pf/auth-policy

Defines the shared authorization service, principal/resource model, and Cedar
schema and default policies. Policy evaluation is provided by
[`@pf/auth-local-cedar`](../auth-local-cedar/README.md).

Applications ask whether a principal may perform an action on a resource.
Organisation policies build on the shared defaults. Cedar permits add access;
an applicable forbid takes precedence over every permit.

Provider Users are identified by their login email in Cedar, rather than by
generated database IDs. Roles describe current authority; authentication alone
does not grant access.

## Delegation issuance and owner listing

Listing Delegations and issuing their secrets are independently authorized.
Organisations explicitly grant these capabilities. Policies can also require
human-session provenance or fresh passkey evidence; refresh does not renew that
evidence. To narrow an existing permit, use a forbid rather than another permit.

See [delegated access](../../docs/authentication/delegated-access.md) for the
lifecycle, and the [Cedar schema](./cedar/schema.cedarschema) and
[default policies](./cedar/policies.cedar) for the current authorization model.
