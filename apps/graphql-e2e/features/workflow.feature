Feature: Process Workflow
  As an authenticated user
  I want to retrieve process workflow information
  So that I can visualize processes with their phases and responsibilities

  Background:
    Given I am authenticated with the "/Employee" role

  Scenario: Query on-boarding workflow with phases and responsibilities
    When I query the workflow for process "/hr/on-boarding"
    Then the workflow should have process name "Onboard a new employee"
    And the workflow should have 5 responsibilities
    And the workflow should have a responsibility "Human Resources tasks" for role "HR"
    And the workflow should have a responsibility "Technical provisioning" for role "IT"
    And the workflow should have at least 10 steps
    And the workflow should have a step "Send welcome packet" in phase "Pre-boarding"
    And the workflow should have a step "Assign a desk/office" in phase "Day 1"
    And the workflow should have a step "Orientation session" in phase "Day 1"
    And the workflow should have a step "Day 30 check-in" in phase "Day 30"
    And the workflow should have a step "Formal performance review" in phase "Day 90"

  Scenario: Query bug-report workflow without phases
    When I query the workflow for process "/engineering/bug-report-fix"
    Then the workflow should have process name "Bug Report and Fix"
    And the workflow should have 0 responsibilities
    And the workflow should have at least 2 steps
    And the workflow should have a step "Report bug details" without a phase
