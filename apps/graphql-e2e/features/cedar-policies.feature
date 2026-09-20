Feature: Cedar Policies GraphQL Access
  As the frontend runtime
  I want to fetch Cedar policies via GraphQL
  So that authorization can be evaluated server-side

  Scenario: Frontend client can fetch cedar policies
    Given I am authenticated as the frontend client
    When I query cedar policies
    Then I should not receive an error
    And cedar policies should be returned

  Scenario: Unauthenticated request is rejected
    Given I am not authenticated
    When I attempt to query cedar policies
    Then I should receive an authentication error

  Scenario: Malformed JWT is rejected
    Given I have a malformed JWT token
    When I attempt to query cedar policies
    Then I should receive an authentication error

  Scenario: Expired JWT is rejected
    Given I have an expired JWT token
    When I attempt to query cedar policies
    Then I should receive an authentication error
