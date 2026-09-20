Feature: Draft Process Execution
  As an authenticated client
  I want to manage draft process executions
  So that I can save and retrieve in-progress process data

  Scenario: Pull draft process executions
    Given I am authenticated with the "/Employee" role
    When I query for draft process executions with limit 100
    Then I should receive a valid draft process execution response

  Scenario: Subscription events are received when pushing draft process executions
    Given I am authenticated as provider user "ci@example.com"
    And I subscribe to draft process execution updates
    And I wait 15000 ms for the subscription to establish
    When I push a new draft process execution
    And I wait for 1 subscription events with timeout 30000 ms
    Then the subscription should not have errors
    And the last subscription event should contain the pushed draft
    And I unsubscribe
