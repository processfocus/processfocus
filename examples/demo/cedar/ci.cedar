// CI/E2E test policies
// These policies enable M2M (machine-to-machine) clients to perform
// authorization checks that would normally require a real user context.

// Allow finance managers to view all executions in the finance org unit.
// This is needed because M2M clients don't have an org unit set,
// so the normal "resource in principal.orgUnit" check fails.
// Note: org unit paths in the database use leading slash only (e.g., "/finance")
permit (
    principal in PF::Role::"/finance/Manager",
    action == PF::Action::"view",
    resource is PF::Execution
)
when {
    resource in PF::OrgUnit::"/finance"
};

// The ci-pipeline account can access the entire graphql API without restriction.
permit (
    principal == PF::ServiceAccount::"ci-pipeline",
    action in [PF::Action::"query", PF::Action::"mutation", PF::Action::"subscription"],
    resource is PF::GraphQLField
);

// The ci-pipeline service account may start and complete steps when its token
// explicitly carries the step's role.
permit (
    principal == PF::ServiceAccount::"ci-pipeline",
    action == PF::Action::"complete",
    resource is PF::Step
)
when {
    principal.roles.contains(resource.role)
};

// The e2e-employee only has graphql api permission to switch to a provider user
permit (
    principal == PF::ServiceAccount::"e2e-employee",
    action in [PF::Action::"mutation"],
    resource == PF::GraphQLField::"Mutation.requestProviderUserPermissions"
);

// The e2e-employee-finance-manager only has graphql api permission to switch to a provider user
permit (
    principal == PF::ServiceAccount::"e2e-employee-finance-manager",
    action in [PF::Action::"mutation"],
    resource == PF::GraphQLField::"Mutation.requestProviderUserPermissions"
);

// The ci-pipeline account can request any role (for testing purposes).
permit (
    principal == PF::ServiceAccount::"ci-pipeline",
    action == PF::Action::"requestRole",
    resource is PF::Role
);

// The ci-pipeline account can use admin-only user-management features in e2e tests.
permit (
    principal == PF::ServiceAccount::"ci-pipeline",
    action == PF::Action::"administerUsers",
    resource is PF::Application
);

// The ci-pipeline account can request provider user permissions (for testing).
permit (
    principal == PF::ServiceAccount::"ci-pipeline",
    action == PF::Action::"requestProviderUserPermissions",
    resource == PF::ProviderUser::"ci@example.com"
);

// The e2e-employee account can request provider user permissions (for testing).
permit (
    principal == PF::ServiceAccount::"e2e-employee",
    action == PF::Action::"requestProviderUserPermissions",
    resource == PF::ProviderUser::"ci@example.com"
);

// Settings e2e smoke: allow the existing ci provider user to browse admin settings.
permit (
    principal == PF::ProviderUser::"ci@example.com",
    action in [PF::Action::"administerUsers", PF::Action::"administerOAuthProviders"],
    resource is PF::Application
);

// The e2e-employee-finance-manager account can request provider user permissions (for testing).
permit (
    principal == PF::ServiceAccount::"e2e-employee-finance-manager",
    action == PF::Action::"requestProviderUserPermissions",
    resource == PF::ProviderUser::"employee-finance-manager@example.com"
);

// E2E multi-user subscription test: allow ci-pipeline to authenticate as these provider users
permit (
    principal == PF::ServiceAccount::"ci-pipeline",
    action == PF::Action::"requestProviderUserPermissions",
    resource == PF::ProviderUser::"employee@example.com"
);

permit (
    principal == PF::ServiceAccount::"ci-pipeline",
    action == PF::Action::"requestProviderUserPermissions",
    resource == PF::ProviderUser::"finance-manager@example.com"
);

permit (
    principal == PF::ServiceAccount::"ci-pipeline",
    action == PF::Action::"requestProviderUserPermissions",
    resource == PF::ProviderUser::"procurement-manager@example.com"
);

// E2E file permissions test: allow ci-pipeline to authenticate as employee-2
permit (
    principal == PF::ServiceAccount::"ci-pipeline",
    action == PF::Action::"requestProviderUserPermissions",
    resource == PF::ProviderUser::"employee-2@example.com"
);

// E2E multi-user subscription test: allow test provider users to access CI-only fields
// These fields are used by the test framework (e.g., hasPendingScheduledFlows)
permit (
    principal == PF::ProviderUser::"employee@example.com",
    action == PF::Action::"query",
    resource == PF::GraphQLField::"Query.hasPendingScheduledFlows"
);

permit (
    principal == PF::ProviderUser::"finance-manager@example.com",
    action == PF::Action::"query",
    resource == PF::GraphQLField::"Query.hasPendingScheduledFlows"
);

permit (
    principal == PF::ProviderUser::"procurement-manager@example.com",
    action == PF::Action::"query",
    resource == PF::GraphQLField::"Query.hasPendingScheduledFlows"
);

// E2E file permissions test: allow employee-2 to access CI-only fields
permit (
    principal == PF::ProviderUser::"employee-2@example.com",
    action == PF::Action::"query",
    resource == PF::GraphQLField::"Query.hasPendingScheduledFlows"
);

// Test that forbidding roles works
forbid (
    principal == PF::ServiceAccount::"ci-pipeline",
    action == PF::Action::"requestRole",
    resource == PF::Role::"/operations/Facilities"
);

// E2E tests: allow service accounts to view the purchase-orders list
permit (
    principal is PF::ServiceAccount,
    action == PF::Action::"view",
    resource == PF::List::"/purchase-orders"
);

// Explicit automated caller grant, scoped to the onboarding acceptance journey.
permit (
    principal == PF::ServiceAccount::"ci-pipeline",
    action == PF::Action::"skipScheduleWaits",
    resource == PF::Process::"/hr/on-boarding"
);

// Observe the whole onboarding journey while switching the task role.
permit (
    principal,
    action == PF::Action::"view",
    resource is PF::Execution
)
when {
    resource in PF::Process::"/hr/on-boarding" &&
    principal in PF::Role::"/hr/HR"
};

permit (
    principal == PF::ServiceAccount::"ci-pipeline",
    action == PF::Action::"showProcessState",
    resource is PF::Application
);

// Facilities requestRole is deliberately forbidden by another acceptance test.
// Grant the onboarding worker journey these task completions directly instead.
permit (
    principal == PF::ServiceAccount::"ci-pipeline",
    action == PF::Action::"complete",
    resource is PF::Step
)
when {
    resource in PF::Process::"/hr/on-boarding" &&
    resource.role == PF::Role::"/operations/Facilities" &&
    principal.roles.contains(PF::Role::"/hr/HR")
};

permit (
    principal == PF::ServiceAccount::"ci-pipeline",
    action == PF::Action::"complete",
    resource is PF::Todo
)
when {
    resource in PF::Process::"/hr/on-boarding" &&
    resource.role == PF::Role::"/operations/Facilities" &&
    principal.roles.contains(PF::Role::"/hr/HR")
};

// Policy/caller acceptance: two exact Process grants. No start-step or display
// name participates in these decisions. Delegations are explicitly opted in.
permit (
    principal,
    action == PF::Action::"skipScheduleWaits",
    resource == PF::Process::"/hr/on-boarding"
)
when {
    (principal is PF::ProviderUser || principal is PF::Delegation) &&
    principal in PF::ProviderUser::"employee@example.com"
};
permit (
    principal,
    action == PF::Action::"skipScheduleWaits",
    resource == PF::Process::"/hr/automation/scheduled-start"
)
when {
    principal == PF::ServiceAccount::"ci-pipeline" &&
    principal.roles.contains(PF::Role::"/hr/HR") ||
    (principal is PF::ProviderUser || principal is PF::Delegation) &&
    principal in PF::ProviderUser::"employee@example.com"
};

// Hierarchy grants exercise real Process -> OrgUnit ancestry, including a
// grandchild process. The CI account requests this role explicitly.
permit (
    principal,
    action == PF::Action::"skipScheduleWaits",
    resource in PF::OrgUnit::"/hr"
)
when {
    principal == PF::ServiceAccount::"ci-pipeline" &&
    principal.roles.contains(PF::Role::"/hr/Manager") ||
    (principal is PF::ProviderUser || principal is PF::Delegation) &&
    principal in PF::ProviderUser::"finance-manager@example.com"
};

permit (
    principal,
    action == PF::Action::"skipScheduleWaits",
    resource is PF::Process
)
when {
    principal == PF::ServiceAccount::"ci-pipeline" &&
    (principal.roles.contains(PF::Role::"/Administrator") || principal.roles.contains(PF::Role::"/operations/IT")) ||
    (principal is PF::ProviderUser || principal is PF::Delegation) &&
    principal in PF::ProviderUser::"procurement-manager@example.com"
};

// Ordinary observers can see mode metadata without acquiring mode permission.
permit (
    principal,
    action == PF::Action::"view",
    resource is PF::Execution
)
when {
    resource in PF::Process::"/hr/automation/scheduled-start" &&
    principal.roles.contains(PF::Role::"/Employee")
};

// Read-only acceptance observer; this does not authorize mode selection.
permit (
    principal == PF::ProviderUser::"employee-2@example.com",
    action == PF::Action::"view",
    resource is PF::Execution
)
when { resource in PF::Process::"/hr/on-boarding" || resource in PF::Process::"/hr/automation/scheduled-start" };

// The service-account role-selection contract permits one role per token.
// Explicit ordinary start grants let the policy fixtures vary mode scope while
// retaining start authority. Administrator has mode-only authority in this test.
permit (
    principal == PF::ServiceAccount::"ci-pipeline",
    action == PF::Action::"complete",
    resource is PF::Step
)
when {
    (principal.roles.contains(PF::Role::"/hr/HR") || principal.roles.contains(PF::Role::"/hr/Manager") || principal.roles.contains(PF::Role::"/operations/IT")) &&
    resource.startsProcess &&
    (resource in PF::Process::"/hr/on-boarding" || resource in PF::Process::"/hr/automation/scheduled-start" || resource in PF::Process::"/hr/time-off-request" || resource in PF::Process::"/operations/scheduled-start")
};
permit (
    principal == PF::ServiceAccount::"ci-pipeline",
    action == PF::Action::"view",
    resource is PF::Execution
)
when { resource in PF::Process::"/hr/on-boarding" || resource in PF::Process::"/hr/automation/scheduled-start" };

// The API acceptance owners are bootstrapped through the existing CI M2M
// convention, not a human login ceremony. Permit own-token listing and secret
// issuance for these fixture owners explicitly; exchanged sessions still use
// PF::Delegation.
permit (
    principal is PF::ProviderUser,
    action in [PF::Action::"listDelegationTokens", PF::Action::"issueDelegationSecret"],
    resource is PF::ProviderUser
)
when {
    principal == resource &&
    [PF::ProviderUser::"ci@example.com", PF::ProviderUser::"employee@example.com", PF::ProviderUser::"finance-manager@example.com", PF::ProviderUser::"procurement-manager@example.com"].contains(principal)
};

// Preserve the existing finance timeline journey using its actual CI principal.
permit (
    principal == PF::ServiceAccount::"ci-pipeline",
    action == PF::Action::"view",
    resource is PF::Execution
)
when {
    principal.roles.contains(PF::Role::"/finance/Manager") &&
    resource in PF::OrgUnit::"/finance"
};
