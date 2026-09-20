Feature: GraphQL subscriptions

  Background:
    Given I am authenticated as provider user "employee-finance-manager@example.com" with roles "/Employee,/finance/Manager" using client "e2e-employee-finance-manager"
    When I visit the processes page
    And I wait for RxDB to populate local storage

  Scenario: Starting a purchase request delivers a new todo via subscription
    Given I note the current todo count in the sidebar
    When I start the "Purchase Request" process
    And I fill in the purchase request form with item "E2E Subscription Test" and value "500"
    And I submit the process form
    Then the todo count in the sidebar should increase
    When I visit the to-dos page
    Then I should see a todo for "Approve purchase request"

  Scenario: Mobile todos opens work directly from the list
    Given I note the current todo count in the sidebar
    When I start the "Purchase Request" process
    And I fill in the purchase request form with item "E2E Mobile Todo Test" and value "500"
    And I submit the process form
    Then the todo count in the sidebar should increase
    And I am using a mobile viewport
    When I visit the to-dos page
    Then I should see the mobile todo worklist
    When I open the todo for "Approve purchase request" from the mobile worklist row
    Then I should be on a todo completion page

  Scenario: Todo work queue supports filtering, sorting, and mobile rendering
    Given I note the current todo count in the sidebar
    When I start the "Purchase Request" process
    And I fill in the purchase request form with item "E2E Todo Queue Smoke" and value "500"
    And I submit the process form
    Then the todo count in the sidebar should increase
    When I visit the to-dos page
    Then I should see a todo card with a Do action for "Approve purchase request"
    When I filter the todo queue by status "Active"
    Then the todo queue should show a custom view with "Approve purchase request"
    When I sort the todo queue by "Alphabetical"
    Then I should see a todo card with a Do action for "Approve purchase request"
    And I am using a mobile viewport
    When I visit the to-dos page
    Then I should see the mobile todo worklist
