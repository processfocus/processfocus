@localhost-only
Feature: Executions initial server synchronization

  Background:
    Given I use the disposable onboarding browser account with Administrator permission

  Scenario Outline: An empty disposable organisation finishes loading after human login
    Given I am using the "<viewport>" Processes viewport
    And the initial execution pull is held with a "empty" result
    When I sign in to Executions through the local dummy provider
    Then the new Executions scope stays loading without a false empty result
    When I release the initial execution pull
    Then Executions finishes with the "empty" result without a false empty flash
    Given the initial execution pull is held with a "empty" result
    When I switch the Dashboard Role to "/operations/Facilities"
    Then the new Executions scope stays loading without a false empty result
    When I release the initial execution pull
    Then Executions finishes with the "empty" result without a false empty flash

    Examples:
      | viewport |
      | desktop  |
      | mobile   |

  Scenario Outline: Login and Role switching wait for authorized running and historical executions
    Given I have running and historical executions in the disposable organisation
    And I am using the "<viewport>" Processes viewport
    And the initial execution pull is held with a "<result>" result
    When I sign in to Executions through the local dummy provider
    Then the new Executions scope stays loading without a false empty result
    When I release the initial execution pull
    Then Executions finishes with the "<result>" result without a false empty flash
    When I switch the Dashboard Role to "/Administrator"
    Then I should see execution browsing for "Purchase Request"
    Given the initial execution pull is held with a "populated" result
    When I switch the Dashboard Role to "/Employee"
    Then the new Executions scope stays loading without a false empty result
    When I release the initial execution pull
    Then Executions finishes with the "populated" result without a false empty flash
    And Executions filters show historical rows and explain misses
    When I delay execution refresh and revisit cached Executions
    Then cached Executions remain usable during refresh and failure

    Examples:
      | viewport | result    |
      | desktop  | populated |
      | mobile   | populated |
      | desktop  | failure   |
      | mobile   | failure   |
