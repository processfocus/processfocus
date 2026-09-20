Feature: Dashboard local cache freshness

  Background:
    Given I am authenticated as provider user "employee-finance-manager@example.com" with roles "/Employee,/finance/Manager" using client "e2e-employee-finance-manager"
    When I visit the processes page
    And I wait for RxDB to populate local storage

  Scenario: A five-day-old cache is rebuilt from server truth
    When I start the "Purchase Request" process
    And I fill in the purchase request form with item "E2E RxDB Refresh Draft" and value "500"
    And I save the process form as a server-side draft
    And I record the current RxDB lifecycle and replication checkpoint
    And I make the current RxDB lifecycle marker exactly five days old
    And I reload the Dashboard without changing authentication
    Then the RxDB reset generation should advance once
    And the previous replication checkpoint should be replaced
    And the server-side draft should be pulled into the fresh database

  @rxdb-multitab
  Scenario: Concurrent tabs coordinate one reset generation and reload peers
    Given another tab is using the same organisation database
    When both tabs resume with a five-day-old lifecycle marker
    Then both tabs should reload onto one new reset generation
