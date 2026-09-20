@localhost-only
Feature: Participant visibility and recovery of Without Waiting work
  Scenario: Ordinary restart permission preserves the visible execution mode
    Given I use the disposable onboarding browser account with restart but without Administrator permission
    And a disposable Without Waiting execution has failed automated work
    When I view the failed Without Waiting execution
    Then I see its mode and failure evidence
    When I repair the action and restart the execution in the browser
    Then the same execution retains its badge and scheduled work becomes ready
    When I open the lifecycle start form
    Then I see the plain Submit action
