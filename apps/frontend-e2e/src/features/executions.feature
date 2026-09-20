Feature: Executions browsing

  Background:
    Given I am authenticated as provider user "employee-finance-manager@example.com" with roles "/Employee,/finance/Manager" using client "e2e-employee-finance-manager"
    When I visit the processes page
    And I wait for RxDB to populate local storage

  Scenario: Authenticated user can browse execution list and detail
    When I start the "Purchase Request" process
    And I fill in the purchase request form with item "E2E Executions Browsing" and value "500"
    And I submit the process form
    And I visit the executions page
    Then I should see execution browsing for "Purchase Request"
    When I filter executions by "In Progress"
    Then I should see execution browsing for "Purchase Request"
    When I open the "Purchase Request" execution from the executions list
    Then I should see execution detail for "Purchase Request"
    And I should see process workflow information for "Purchase Request"
    When I view process workflow information for "Purchase Request"
    Then I should see the "Purchase Request" workflow diagram
