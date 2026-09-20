Feature: Leave Request
  As a provider user
  I want to submit time off requests
  So that I can get leave approved by my manager

  Background:
    Given I am authenticated without roles
    And the database is clean

  Scenario: Submit and approve time off request
    # HR Manager starts with no todos
    Given I am authenticated with the "/hr/Manager" role
    When I query for todos with limit 100
    Then I should have 0 todos

    # Employee submits a time off request
    Given I am authenticated with the "/Employee" role
    When I start a time off request for dates "2026-03-15 to 2026-03-20"
    And I wait for flow to advance

    # Employee should have no todos (manager approval pending)
    When I query for todos with limit 100
    Then I should have 0 todos

    # HR Manager should now have 1 todo for approval
    Given I am authenticated with the "/hr/Manager" role
    When I query for todos with limit 100
    Then I should have 1 todo
    And the todo should be for step "Approve time off request"
    And the todo summary should contain "When" with value "2026-03-15 to 2026-03-20"
    And the todo summary should contain "Requester" with value "ci-pipeline"

    # Manager approves the request
    When I complete the first todo with time off approval
    And I wait for flow to advance

    # HR Manager should now have a notification todo
    When I query for todos with limit 100
    Then I should have 1 todo
    And the todo should be for step "Notify employee of decision"

    # Manager acknowledges the notification
    When I complete the first todo as notification acknowledgment
    And I wait for flow to advance

    # HR Manager should have no more todos
    When I query for todos with limit 100
    Then I should have 0 todos

    # Employee should also have no todos
    Given I am authenticated with the "/Employee" role
    When I query for todos with limit 100
    Then I should have 0 todos
    And there are no more flows to advance
