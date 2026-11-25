@oidc-only
Feature: Deployed workload capability boundaries
  Scenario: A direct workload cannot issue download URLs or delete invitations
    Given I am authenticated without roles
    Then workload download handoffs and credential administration are denied
