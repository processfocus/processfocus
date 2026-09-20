// Provider users with the Employee role can start all processes.
// (Start steps are identified by startsProcess=true).
permit (
    principal in PF::Role::"/Employee",
    action == PF::Action::"complete",
    resource is PF::Step
)
when {
    resource.startsProcess &&
    (resource has role || principal in PF::Role::"/Administrator")
};

// In the demo org, role-less start steps are intentionally hard-coded as
// admin-only.
forbid (
    principal is PF::ProviderUser,
    action == PF::Action::"complete",
    resource is PF::Step
)
when {
    resource.startsProcess && !(resource has role) && !(principal in PF::Role::"/Administrator")
};

permit (
    principal in PF::Role::"/Administrator",
    action == PF::Action::"complete",
    resource is PF::Step
)
when {
    resource.startsProcess && !(resource has role)
};

// The finance manager can view all executions of any process that
// had/have todos in finance.
permit (
    principal in PF::Role::"/finance/Manager",
    action == PF::Action::"view",
    resource is PF::Execution
)
when {
    resource in principal.orgUnit
};

// Administrators can approve time-off.
permit (
    principal in PF::Role::"/Administrator",
    action == PF::Action::"complete",
    resource == PF::Step::"/hr/time-off-request/Approve time off"
);

// Administrators can approve purchases.
permit (
    principal in PF::Role::"/Administrator",
    action == PF::Action::"complete",
    resource == PF::Step::"/finance/purchase-request/Manager approval"
);

// Administrators can complete any step under the /finance/purchase-request process,
// but only in development, and only after 6am local time.
permit (
    principal in PF::Role::"/Administrator",
    action == PF::Action::"complete",
    resource in PF::Process::"/finance/purchase-request"
)
when {
    (context.nodeEnv == "development") && (context.requestTime.toTime() >= duration("6h"))
};

// Administrators can complete any step in finance
permit (
    principal in PF::Role::"/Administrator",
    action == PF::Action::"complete",
    resource in PF::OrgUnit::"/finance"
);

// Administrators can request any role (including ones they don't have)
permit (
    principal is PF::ProviderUser in PF::Role::"/Administrator",
    action == PF::Action::"requestRole",
    resource is PF::Role
);

// Feature-based authorization for Administrators
// Allows access to user administration features (allUsers, userDetail, allRoles, updateProviderUser)
permit (
    principal is PF::ProviderUser in PF::Role::"/Administrator",
    action == PF::Action::"administerUsers",
    resource is PF::Application
);

// Allows access to OAuth provider administration features (allOAuthProviders)
permit (
    principal is PF::ProviderUser in PF::Role::"/Administrator",
    action == PF::Action::"administerOAuthProviders",
    resource is PF::Application
);

// Allows access to view process state (debugging feature)
permit (
    principal in PF::Role::"/Administrator",
    action == PF::Action::"showProcessState",
    resource is PF::Application
);

// Human administrators can inspect security policies and schema by default.
permit (
    principal is PF::ProviderUser in PF::Role::"/Administrator",
    action == PF::Action::"viewAuthorization",
    resource is PF::Application
);

// Human Administrators can see and issue their own Delegation Tokens. The
// ProviderUser type restriction prevents their Delegations inheriting this
// authority through the owner's Administrator role.
permit (
    principal is PF::ProviderUser in PF::Role::"/Administrator",
    action == PF::Action::"listDelegationTokens",
    resource is PF::ProviderUser
)
when { principal == resource };

permit (
    principal is PF::ProviderUser in PF::Role::"/Administrator",
    action == PF::Action::"issueDelegationSecret",
    resource is PF::ProviderUser
)
when {
    principal == resource &&
    (
        context.humanSession ||
        (
            context has humanAuthentication &&
            context.humanAuthentication.providerUserId == context.ownerProviderUserId &&
            context.humanAuthentication.method == "passkey"
        )
    )
};

// Administrators can investigate any process execution state.
permit (
    principal in PF::Role::"/Administrator",
    action == PF::Action::"view",
    resource is PF::Execution
);

// Administrators can restart any execution
permit (
    principal in PF::Role::"/Administrator",
    action == PF::Action::"restart",
    resource is PF::Execution
);

// Only the file owner can download files.
forbid (
    principal is PF::ProviderUser,
    action == PF::Action::"download",
    resource is PF::File
)
unless {
    principal == resource.owner
};

// Selecting Without Waiting is explicitly restricted to human Administrators.
permit (
    principal is PF::ProviderUser in PF::Role::"/Administrator",
    action == PF::Action::"skipScheduleWaits",
    resource is PF::Process
);
