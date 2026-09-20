Feature: Logout

  Background:
    Given I am authenticated as provider user "ci@example.com"
    And I visit the home page
    And I wait for RxDB to populate local storage

  Scenario: Logout from sidebar clears all session data
    When I click the sidebar logout button
    Then I should be redirected to the login page
    And all RxDB local storage should be cleared
    And all authentication cookies should be cleared

  Scenario: Logout from profile dropdown clears all session data
    When I open the profile dropdown
    And I click the header logout button
    Then I should be redirected to the login page
    And all RxDB local storage should be cleared
    And all authentication cookies should be cleared
