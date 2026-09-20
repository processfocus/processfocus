@localhost-only
Feature: Without Waiting submission
  Scenario: Unprivileged users retain plain Submit
    Given I use the disposable onboarding browser account without Administrator permission
    When I open the onboarding start form
    Then I see the plain Submit action

  Scenario: Submission validates, defaults and displays persisted mode
    Given I use the disposable onboarding browser account with Administrator permission
    When I open the onboarding start form
    Then Without Waiting submits only after validation
    When I fill a future onboarding form
    And I submit onboarding without waiting
    Then the execution list and detail show Without waiting
    When I complete this onboarding execution in the browser
    When I open the onboarding start form
    Then the main Submit action still starts an ordinary execution

  Scenario: Reopened drafts keep normal Submit as the default
    Given I use the disposable onboarding browser account with Administrator permission
    When I open the onboarding start form
    Then Without Waiting submits only after validation
    When I fill a future onboarding form
    And I save and reopen the onboarding draft
    Then the main Submit action still starts an ordinary execution
