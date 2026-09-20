Feature: Subscription Authorization
  As a GraphQL API
  I need to enforce subscription channel authorization
  So that users cannot access other users' real-time data

  Background:
    Given I am authenticated without roles
    And the database is clean

  @aws-only
  Scenario: User cannot subscribe to another user's subscription channel
    Given "alice" is authenticated as provider user "ci@example.com"
    And "bob" is authenticated as provider user "employee@example.com"
    And "alice" subscribes to todo updates
    When "alice" tries to subscribe to "bob"'s "todo" channel
    Then "alice"'s subscription should be rejected
