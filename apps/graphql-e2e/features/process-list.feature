Feature: Provider-user Process catalog
  As a provider user
  I want a paged list of the Processes I can start
  So that denied Processes and RxDB fields never appear in the list API

  Background:
    Given I am authenticated without roles
    And the database is clean
    And I am authenticated as provider user "employee@example.com"

  Scenario: Paging and filters apply to Cedar-visible Processes
    When I query Process list page 1 with limit 1
    Then the latest Process list page has 1 node and hasNextPage is true
    And the latest Process list node has only the public Process keys
    When I query Process list page 1 with limit 10 for process "/finance/purchase-request" and status "Active"
    Then the latest Process list page has 1 node and hasNextPage is false
    And the latest Process list includes process "/finance/purchase-request"

  Scenario: Cedar hides a Process whose start step the provider user cannot complete
    When I query Process list page 1 with limit 100
    Then the latest Process list includes process "/finance/purchase-request"
    And the latest Process list excludes process "/operations/hello-system-start"
