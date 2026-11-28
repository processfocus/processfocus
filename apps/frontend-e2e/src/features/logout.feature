Feature: Logout

  Background:
    Given I am authenticated as provider user "ci@example.com"
    And I visit the home page
    And the Dashboard live metrics are visible
    And I wait for RxDB to populate local storage
    And I am watching for logout errors

  Scenario: Logout from sidebar clears all session data
    When I click the sidebar logout button
    Then I should be redirected to the login page
    And all RxDB local storage should be cleared
    And all authentication cookies should be cleared
    And logout should report no cleanup errors or uncaught exceptions

  Scenario: Logout from profile dropdown clears all session data
    When I open the profile dropdown
    And I click the header logout button
    Then I should be redirected to the login page
    And all RxDB local storage should be cleared
    And all authentication cookies should be cleared
    And logout should report no cleanup errors or uncaught exceptions
