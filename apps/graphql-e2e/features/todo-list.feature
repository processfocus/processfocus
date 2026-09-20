Feature: Provider-user Todo list
  As a provider user
  I want a paged list of the Todos I can complete
  So that denied rows and RxDB fields never appear in the list API

  Background:
    Given I am authenticated without roles
    And the database is clean
    And I am authenticated with the "/Employee" role
    When I start a purchase request for item "Chair" with value "150"
    And I wait for flow to advance
    When I start a purchase request for item "Desk" with value "250"
    And I wait for flow to advance

  Scenario: Paging and filters apply to Cedar-visible Todos
    Given I am authenticated as provider user "finance-manager@example.com"
    When I query Todo list page 1 with limit 1
    Then the latest Todo list page has 1 node and hasNextPage is true
    And the latest Todo list node has only the public Todo keys
    When I query Todo list page 2 with limit 1
    Then the latest Todo list page has 1 node and hasNextPage is false
    And the first nodes of the last two Todo list pages are different
    When I query Todo list page 1 with limit 10 for process "/finance/purchase-request" and status "Active"
    Then the latest Todo list page has 2 nodes and hasNextPage is false
    When I query Todo list page 1 with limit 10 for process "/finance/purchase-request" and status "Completed"
    Then the latest Todo list page has 0 nodes and hasNextPage is false

  Scenario: Cedar hides another role's Todos
    Given I am authenticated as provider user "employee@example.com"
    When I query Todo list page 1 with limit 10
    Then the latest Todo list page has 0 nodes and hasNextPage is false
