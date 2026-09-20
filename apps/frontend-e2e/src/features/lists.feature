Feature: Lists browsing

  Background:
    Given I am authenticated as provider user "employee-finance-manager@example.com" with roles "/Employee,/finance/Manager" using client "e2e-employee-finance-manager"

  Scenario: Authenticated user can browse a read-only list table
    When I visit the process catalog browsing list
    Then I should see process catalog list data for "Purchase Request"
    When I sort the process catalog browsing list by "Name"
    Then I should see process catalog list data for "Purchase Request"
