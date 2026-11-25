// Normal-authenticated API fixtures use unique users. Marker roles replace
// email-specific test grants; machines with those roles are not Provider Users.
permit (
    principal is PF::ProviderUser,
    action in [PF::Action::"administerUsers", PF::Action::"administerOAuthProviders", PF::Action::"viewAuthorization"],
    resource is PF::Application
) when { principal in PF::Role::"/GraphQLE2ECI" };

permit (
    principal is PF::ProviderUser,
    action == PF::Action::"query",
    resource == PF::GraphQLField::"Query.hasPendingScheduledFlows"
) when {
    principal in PF::Role::"/GraphQLE2EEmployee" ||
    principal in PF::Role::"/GraphQLE2EObserver" ||
    principal in PF::Role::"/GraphQLE2EFinance" ||
    principal in PF::Role::"/GraphQLE2EProcurement"
};

permit (
    principal,
    action == PF::Action::"skipScheduleWaits",
    resource is PF::Process
) when {
    (principal is PF::ProviderUser || principal is PF::Delegation) &&
    (
        principal in PF::Role::"/GraphQLE2EEmployee" &&
        (resource == PF::Process::"/hr/on-boarding" || resource == PF::Process::"/hr/automation/scheduled-start") ||
        principal in PF::Role::"/GraphQLE2EFinance" && resource in PF::OrgUnit::"/hr" ||
        principal in PF::Role::"/GraphQLE2EProcurement"
    )
};

permit (
    principal is PF::ProviderUser,
    action == PF::Action::"view",
    resource is PF::Execution
) when {
    principal in PF::Role::"/GraphQLE2EObserver" &&
    (resource in PF::Process::"/hr/on-boarding" || resource in PF::Process::"/hr/automation/scheduled-start")
};

permit (
    principal is PF::ProviderUser,
    action in [PF::Action::"listDelegationTokens", PF::Action::"issueDelegationSecret"],
    resource is PF::ProviderUser
) when {
    principal == resource &&
    (
        principal in PF::Role::"/GraphQLE2ECI" ||
        principal in PF::Role::"/GraphQLE2EEmployee" ||
        principal in PF::Role::"/GraphQLE2EFinance" ||
        principal in PF::Role::"/GraphQLE2EProcurement"
    )
};
