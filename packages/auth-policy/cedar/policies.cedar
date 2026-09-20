// Account recovery is deliberately denied by default. The Cloud Backend's
// custom policy explicitly grants recoverProviderUser to human Administrators;
// ordinary user-administration or deployment authority must not imply recovery.

// Ordinary work includes humans and their distinct Delegations.
// Roles are explicit trusted facts, not inherited attributes.
// Provider users can complete a step if they have the step's role.
permit (
    principal,
    action == PF::Action::"complete",
    resource is PF::Step
)
when {
    (principal is PF::ProviderUser || principal is PF::Delegation) &&
    resource has role &&
    principal.roles.contains(resource.role)
};

// Provider users can complete active todos for role-authorized work.
// Directly assigned todos are narrowed to the assigned provider user by default.
permit (
    principal,
    action == PF::Action::"complete",
    resource is PF::Todo
)
when {
    (principal is PF::ProviderUser || principal is PF::Delegation) &&
    resource has role &&
    principal.roles.contains(resource.role) &&
    (
        !(resource has assignedTo) ||
        principal in resource.assignedTo
    )
};

// Provider users can correct Public Completion delivery failures through a
// distinct action. Callers choose the responsible or execution-failure role
// candidate when constructing the Todo resource.
permit (
    principal,
    action == PF::Action::"publicCompletionCorrection",
    resource is PF::Todo
)
when {
    (principal is PF::ProviderUser || principal is PF::Delegation) &&
    resource has role &&
    principal.roles.contains(resource.role) &&
    (
        !(resource has assignedTo) ||
        principal in resource.assignedTo
    )
};

// Service accounts with a requested role can complete unassigned role todos.
// Directly assigned todos stay provider-user-owned by default.
permit (
    principal is PF::ServiceAccount,
    action == PF::Action::"complete",
    resource is PF::Todo
)
when {
    resource has role &&
    principal.roles.contains(resource.role) &&
    !(resource has assignedTo)
};

// Provider users can modify submitted form fields if they have the field's role.
permit (
    principal,
    action == PF::Action::"modifyField",
    resource is PF::FormField
)
when {
    (principal is PF::ProviderUser || principal is PF::Delegation) &&
    resource has role &&
    principal.roles.contains(resource.role)
};

// Public todo links can complete only the todo embedded in the encrypted token.
// This is self-authorizing today, and intentionally keeps public-link scoping
// in Cedar so future revocation/scoping rules can be policy-owned.
permit (
    principal is PF::PublicLink,
    action == PF::Action::"complete",
    resource is PF::Todo
)
when {
    principal.todo == resource
};

// Provider users can login if they have at least one role.
permit (
    principal,
    action == PF::Action::"login",
    resource is PF::Application
)
when {
    (principal is PF::ProviderUser || principal is PF::Delegation) &&
    principal.roles.isEmpty() == false
};

// Provider users can request any role they already have.
// Normally they see / can do anything for all the roles they have,
// this allows them to limit their view.
permit (
    principal,
    action == PF::Action::"requestRole",
    resource is PF::Role
)
when {
    (principal is PF::ProviderUser || principal is PF::Delegation) &&
    principal.roles.contains(resource)
};

// actOnBehalfOf has no default permit; custom deployment policies may grant it
// to selected users or service accounts.

// Provider users can view executions they started.
permit (
    principal,
    action == PF::Action::"view",
    resource is PF::Execution
)
when {
    (principal is PF::ProviderUser || principal is PF::Delegation) &&
    resource has startedBy &&
    principal in resource.startedBy
};

// restart has no default permit; custom deployment policies may grant it.

// skipScheduleWaits has no default permit; custom deployment policies must
// explicitly grant it on the selected Process. Ordinary start permission is
// still required independently.

// Provider users can draft (view/edit draft process executions) for steps they can complete.
permit (
    principal,
    action == PF::Action::"draft",
    resource is PF::Step
)
when {
    (principal is PF::ProviderUser || principal is PF::Delegation) &&
    resource has role &&
    principal.roles.contains(resource.role)
};

// Provider users with roles can access untagged GraphQL fields or fields tagged
// for provider-user or embedded-form use. The embed tag is also used on shared
// lookup fields that authenticated forms still call directly.
permit (
    principal,
    action in [PF::Action::"query", PF::Action::"mutation", PF::Action::"subscription"],
    resource is PF::GraphQLField
)
when {
    (principal is PF::ProviderUser || principal is PF::Delegation) &&
    principal.roles.isEmpty() == false &&
    (
        !(resource has tag) ||
        resource.tag == "providerUser" ||
        resource.tag == "embed"
    )
};

// Frontend service account can read bootstrap organization and Cedar policy data.
permit (
    principal == PF::ServiceAccount::"frontend",
    action == PF::Action::"query",
    resource == PF::GraphQLField::"Query.org"
);

permit (
    principal == PF::ServiceAccount::"frontend",
    action == PF::Action::"query",
    resource == PF::GraphQLField::"Query.cedarPolicies"
);

permit (
    principal == PF::ServiceAccount::"frontend",
    action in [PF::Action::"query", PF::Action::"mutation"],
    resource is PF::GraphQLField
)
when {
    resource has tag && resource.tag == "embed"
};

permit (
    principal == PF::ServiceAccount::"frontend",
    action == PF::Action::"complete",
    resource is PF::Step
)
when {
    resource.embedded
};

// Scheduler service account can invoke cron-tagged start mutations only.
permit (
    principal == PF::ServiceAccount::"scheduler",
    action == PF::Action::"mutation",
    resource is PF::GraphQLField
)
when {
    resource has tag && resource.tag == "cron"
};

// Scheduler starts system-owned cron processes through the normal start-step
// authorization path, so only role-less start steps are allowed by default.
permit (
    principal == PF::ServiceAccount::"scheduler",
    action == PF::Action::"complete",
    resource is PF::Step
)
when {
    resource.startsProcess &&
    !(resource has role)
};

// Provider users can access a List if they have one of the list's allowed roles.
permit (
    principal,
    action == PF::Action::"view",
    resource is PF::List
)
when {
    (principal is PF::ProviderUser || principal is PF::Delegation) &&
    principal.roles.containsAny(resource.roles)
};

// Provider users can update a List if they have one of the list's allowed roles.
permit (
    principal,
    action == PF::Action::"update",
    resource is PF::List
)
when {
    (principal is PF::ProviderUser || principal is PF::Delegation) &&
    principal.roles.containsAny(resource.roles)
};

// File owners can download their own files.
permit (
    principal,
    action == PF::Action::"download",
    resource is PF::File
)
when {
    (principal is PF::ProviderUser || principal is PF::Delegation) &&
    principal in resource.owner
};

// File owners can delete their own files.
permit (
    principal,
    action == PF::Action::"delete",
    resource is PF::File
)
when {
    (principal is PF::ProviderUser || principal is PF::Delegation) &&
    principal in resource.owner
};
// Secret ownership is a shared boundary: organisation permits cannot authorize
// a human or Delegation to mint a generation for another represented user.
forbid (
    principal is PF::ProviderUser,
    action == PF::Action::"issueDelegationSecret",
    resource is PF::ProviderUser
)
unless { principal == resource };

forbid (
    principal is PF::Delegation,
    action == PF::Action::"issueDelegationSecret",
    resource is PF::ProviderUser
)
unless { principal.owner == resource };

forbid (
    principal is PF::ProviderUser,
    action == PF::Action::"replaceDelegation",
    resource is PF::Delegation
)
unless { principal == resource.owner };

forbid (
    principal is PF::Delegation,
    action == PF::Action::"replaceDelegation",
    resource is PF::Delegation
)
unless { principal.owner == resource.owner };

permit (
    principal is PF::ProviderUser,
    action in [PF::Action::"renameDelegation", PF::Action::"replaceDelegation", PF::Action::"revokeDelegation"],
    resource is PF::Delegation
)
when { principal == resource.owner };

// Human administrators can inspect and revoke other owners' delegated access,
// but do not automatically gain rename, issuance, or replacement authority.
permit (
    principal is PF::ProviderUser in PF::Role::"/Administrator",
    action == PF::Action::"listDelegationTokens",
    resource is PF::ProviderUser
)
when { principal != resource };

permit (
    principal is PF::ProviderUser in PF::Role::"/Administrator",
    action == PF::Action::"revokeDelegation",
    resource is PF::Delegation
);

// List creation has no default grant. Organisations explicitly permit
// PF::Action::"create" on opted-in PF::List resources.
