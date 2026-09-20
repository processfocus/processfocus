Feature: Execution Timeline
  As a user
  I want to view process execution timelines
  So that I can track progress of running processes

  Background:
    Given I am authenticated without roles
    And the database is clean

  Scenario: Pull execution shows no duplicate steps for expensive purchase request
    # Start expensive purchase request which goes through manager -> procurement approval
    Given I am authenticated with the "/Employee" role
    When I start a purchase request for item "Server" with value "5000"
    And I wait for flow to advance

    # Complete manager approval
    Given I am authenticated with the "/finance/Manager" role
    When I query for todos with limit 100
    Then I should have 1 todo
    And the todo should be for step "Approve purchase request"
    When I complete the first todo with manager approval
    And I wait for flow to advance

    # Now procurement step is active - verify todo exists
    Given I am authenticated with the "/procurement/Manager" role
    When I query for todos with limit 100
    Then I should have 1 todo
    And the todo should be for step "Approve expensive purchase request"

    # Pull executions as finance/Manager (authorized via ci.cedar policy)
    # This tests that the execution timeline doesn't show duplicate steps
    Given I am authenticated with the "/finance/Manager" role
    When I pull executions with limit 100
    Then I should have at least 1 execution
    And execution steps should have no duplicates
    And the step "Approve expensive purchase request" should appear exactly 1 time
