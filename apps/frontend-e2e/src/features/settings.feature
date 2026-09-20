Feature: Settings

  Scenario: Administrator can browse settings tables and open a user detail
    Given I am authenticated as provider user "ci@example.com"
    When I visit the settings page
    Then I should see settings users table data
    When I open the "Roles" settings table
    Then I should see settings roles table data
    When I open the "Invited Users" settings table
    Then I should see settings invitations table data
    When I open the "Providers" settings table
    Then I should see settings providers table data
    When I open the "Users" settings table
    And I open the settings user row for "ci@example.com"
    Then I should see the settings user detail for "ci@example.com"
