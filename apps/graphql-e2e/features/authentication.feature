Feature: JWT Authentication
  As a GraphQL API
  I need to enforce JWT authentication
  So that only authorized users can access the API

  # HTTP Authentication Tests

  Scenario: Unauthenticated request is rejected
    Given I am not authenticated
    When I attempt to query the org
    Then I should receive an authentication error

  Scenario: Expired JWT is rejected
    Given I have an expired JWT token
    When I attempt to query the org
    Then I should receive an authentication error

  Scenario: Invalid JWT signature is rejected
    Given I have a JWT with invalid signature
    When I attempt to query the org
    Then I should receive an authentication error

  # Cookie-based Authentication Tests

  Scenario: Cookie-based authentication is accepted
    Given I am authenticated with the "/Employee" role
    When I query the org using cookie authentication
    Then the org name should be "Demo Org"

  Scenario: Request without cookie or header is rejected
    Given I am not authenticated
    When I query the org using cookie authentication
    Then I should receive an authentication error

  # WebSocket Authentication Tests

  Scenario: WebSocket connection without token is rejected
    Given I am not authenticated
    When I try to subscribe to todo updates
    Then the subscription should have an authentication error

  Scenario: WebSocket connection with expired token is rejected
    Given I have an expired JWT token
    When I try to subscribe to todo updates
    Then the subscription should have an authentication error

  Scenario: WebSocket connection with valid token succeeds
    Given I am authenticated with the "/Employee" role
    And I subscribe to todo updates
    Then the subscription should not have errors
    And I unsubscribe

  # Cedar Authorization Tests

  Scenario: Provider user cannot access CI-only mutations
    Given I am authenticated as provider user "ci@example.com"
    When I attempt to call cleanupExecutions
    Then I should receive an authorization error for "Mutation.cleanupExecutions"

  Scenario: Service account can access CI-only mutations
    Given I am authenticated without roles
    When I call cleanupExecutions
    Then I should not receive an error

  Scenario: Service account cannot request forbidden role
    When I authenticate with the "/operations/Facilities" role
    Then I should receive an invalid_scope error

  # Note: The role used here must NOT have been requested by any other test,
  # otherwise the permitted_client_role entry will already exist in the database.
  Scenario: Service account cannot use role without prior requestRole call
    When I authenticate directly with the "/operations/Facilities" role scope
    Then I should receive an invalid_scope error

  Scenario: Service account cannot request non-existent role via GraphQL
    When I authenticate with the "/NonExistent" role
    Then I should receive an invalid_scope error

  Scenario: Service account cannot authenticate with non-existent role scope
    When I authenticate directly with the "/NonExistent" role scope
    Then I should receive an invalid_scope error
