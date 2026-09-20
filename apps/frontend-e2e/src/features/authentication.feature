Feature: Authentication

  Scenario: Unauthenticated user on home page redirects to login without redirect param
    Given I am not logged in
    When I visit the home page
    Then I should be redirected to the login page
    And the login URL should not have a redirect parameter

  Scenario: Unauthenticated user on protected page has redirect parameter in URL
    Given I am not logged in
    When I visit the processes page
    Then I should be redirected to the login page
    And the login URL should have a redirect parameter for "/processes"

  Scenario: Unauthenticated user can open passkey registration without login redirect
    Given I am not logged in
    When I visit the passkey registration page
    Then I should stay on the passkey registration page
    And I should see that registration is unavailable

  Scenario: Authenticated user can access the home page
    Given I am authenticated as provider user "ci@example.com"
    When I visit the home page
    Then I should see the home page
    And I should see the organisation name "Demo"

  Scenario: Authenticated user sees the desktop dashboard summary
    Given I am authenticated as provider user "ci@example.com"
    When I visit the home page
    And I wait for RxDB to populate local storage
    Then I should see the home page
    And I should see the desktop dashboard summary
    And I should not see a visible error boundary
