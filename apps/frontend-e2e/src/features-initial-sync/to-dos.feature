@localhost-only
Feature: My To-Dos initial server synchronization

  Background:
    Given I use the disposable onboarding browser account with Administrator permission
    When I sign in to Processes through the local dummy provider
    And I switch the Dashboard Role to "/Administrator"
    Then I should see the "Purchase Request" process
    When I start the "Purchase Request" process
    And I fill in the purchase request form with item "Initial sync acceptance" and value "500"
    And I submit the process form
    And I visit the to-dos page
    Then I should see a todo for "Approve purchase request"

  Scenario Outline: New scope waits for assigned work and recovers from failed pulls
    Given I am using the "<viewport>" Processes viewport
    And the initial todo pull is held with a "<result>" result
    When I sign in to To-Dos through the local dummy provider
    Then the new To-Dos scope stays loading without a false empty result
    When I release the initial todo pull
    Then To-Dos finishes with the "<result>" result without a false empty flash

    Examples:
      | viewport | result    |
      | desktop  | populated |
      | mobile   | populated |
      | desktop  | failure   |
      | mobile   | failure   |

  Scenario Outline: Role switching confirms an authorized empty queue
    Given I am using the "<viewport>" Processes viewport
    And the initial todo pull is held with a "empty" result
    When I switch the Dashboard Role to "/Employee"
    Then the new To-Dos scope stays loading without a false empty result
    When I release the initial todo pull
    Then To-Dos finishes with the "empty" result without a false empty flash
    Given the initial todo pull is held with a "populated" result
    When I switch the Dashboard Role to "/Administrator"
    Then the new To-Dos scope stays loading without a false empty result
    When I release the initial todo pull
    Then To-Dos finishes with the "populated" result without a false empty flash
    When I delay todo refresh and revisit the cached queue
    Then cached To-Dos remain usable during refresh

    Examples:
      | viewport |
      | desktop  |
      | mobile   |

  Scenario: Filters distinguish excluded work from an empty queue
    Then To-Dos filter misses describe the active filters
