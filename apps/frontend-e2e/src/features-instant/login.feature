Feature: Production instant UI

  Scenario: Login shell precedes request-specific login errors
    When I inspect the instant login shell
    Then the login error streams after the instant scope

  Scenario: Configured browser plugin composition boots in production
    Given I am not logged in
    When I open the frontend boot health page
    Then the frontend boot health marker reports "ready"
