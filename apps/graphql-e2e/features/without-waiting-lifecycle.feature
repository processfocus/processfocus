@without-waiting-lifecycle @localhost-only
Feature: Continue and recover accepted Without Waiting executions
  Background:
    Given I am authenticated without roles
    And the database is clean

  Scenario: Restarted workers retain mode, conditions, real time and completion barriers
    When I continue a durable Without Waiting execution across a runtime restart

  Scenario: Ordinary restart authority recovers failed work in the same execution
    When an ordinary participant recovers a failed Without Waiting execution

  Scenario: An authored error branch preserves failed-work evidence and continues
    When a Without Waiting failure takes its authored error branch

  Scenario: Invalid schedules fail normally in both modes
    When invalid schedules are evaluated in both execution modes

  Scenario: Retryable actions retain their operational retry interval
    When a Without Waiting action retries through the ordinary queue delay

  Scenario: Onboarding retains its business date and later schedules after revocation
    When another participant continues onboarding after starter revocation and runtime restart
