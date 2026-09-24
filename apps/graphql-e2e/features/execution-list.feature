@execution-list
Feature: Provider-user Process Execution list
  As a provider user
  I want a paged list of the Process Executions I can view
  So that default and organisation-specific Cedar visibility is preserved

  Background:
    Given I am authenticated without roles
    And the database is clean
    And I am authenticated as provider user "employee@example.com"
    When I start a purchase request for item "Chair" with value "150"
    And I wait for flow to advance
    And I am authenticated with the "/Employee" role
    When I start a purchase request for item "Desk" with value "250"
    And I wait for flow to advance

  Scenario: Paging and filters apply to Cedar-visible Process Executions
    Given I am authenticated as provider user "finance-manager@example.com"
    When I query Execution list page 1 with limit 1
    Then the latest Execution list page has 1 node and hasNextPage is true
    And the latest Execution list node has only the public Execution keys
    When I query Execution list page 2 with limit 1
    Then the latest Execution list page has 1 node and hasNextPage is false
    And the first nodes of the last two Execution list pages are different
    When I query Execution list page 1 with limit 10 for process "/finance/purchase-request" and status "Running"
    Then the latest Execution list page has 2 nodes and hasNextPage is false
    When I query Execution list page 1 with limit 10 for process "/finance/purchase-request" and status "Completed"
    Then the latest Execution list page has 0 nodes and hasNextPage is false

  Scenario: Default Cedar visibility only returns Process Executions I started
    Given I am authenticated as provider user "employee@example.com"
    When I query Execution list page 1 with limit 10
    Then the latest Execution list page has 1 node and hasNextPage is false

  Scenario: Single execution reads return the authorized persisted projection
    Given I am authenticated as provider user "employee@example.com"
    When I start a purchase request for item "Laptop" with value "300"
    And I wait for flow to advance
    And I am authenticated as provider user "finance-manager@example.com"
    Then I can read the started Execution with its persisted details and capabilities
    And the single Execution query requires an id and the list query has no id argument

  Scenario: Single execution reads do not reveal inaccessible or missing executions
    Given I am authenticated as provider user "employee@example.com"
    Then the started Execution is not accessible by id
    And an unknown Execution id returns null
