@localhost-only
Feature: Follow Execution progress over MCP

  @timeout:180000
  Scenario: Execution discovery and detail honor current visibility
    Then read-only MCP clients can page and inspect only their visible purchase Executions

  @timeout:180000
  Scenario: Detail includes simultaneous current Steps without inventing an estimate
    Given I use the disposable onboarding browser account with Administrator permission
    When I open the onboarding start form
    And I fill a future onboarding form
    And I submit onboarding without waiting
    Then a read-only MCP client reports the parallel onboarding Steps without an estimate
