Feature: Production Dashboard destination shells

  Background:
    Given I am authenticated as provider user "employee-finance-manager@example.com" with roles "/Employee,/finance/Manager" using client "e2e-employee-finance-manager"

  Scenario: Sidebar process navigation preserves the local catalog
    When I inspect instant sidebar process navigation
    Then I should see the "Purchase Request" process

  Scenario: Workflow information arrives before fresh workflow data
    When I inspect instant workflow navigation
    Then the workflow data streams after the instant scope
    And workflow navigation supports back and forward

  Scenario: Hovered List navigation arrives before fresh records
    When I inspect instant List navigation
    Then I should see process catalog list data for "Purchase Request"

  Scenario: Catalog workflow links share a shell without fetching form data
    When I inspect prefetch cost across the process catalog

  Scenario: Process form values survive modal history and full-page reopening
    When I visit the processes page
    And I start the "Purchase Request" process
    And I fill in the purchase request form with item "Navigation draft" and value "750"
    Then the unsaved process form survives back, forward and full-page reopening
