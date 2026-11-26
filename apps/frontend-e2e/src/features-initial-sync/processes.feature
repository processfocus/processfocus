@localhost-only
Feature: Processes initial server synchronization

  Background:
    Given I use the disposable onboarding browser account with Administrator permission

  Scenario Outline: A fresh catalog waits for the complete pull after human login
    Given I am using the "<viewport>" Processes viewport
    And the initial process pull is held with a "<result>" result
    When I sign in to Processes through the local dummy provider
    Then the new Processes scope stays loading without a false empty result
    When I release the initial process pull
    Then Processes finishes with the "<result>" result without a false empty flash

    Examples:
      | viewport | result    |
      | desktop  | populated |
      | mobile   | populated |
      | desktop  | failure   |

  Scenario Outline: A Role with no start permissions receives an authorized empty catalog
    Given I am using the "<viewport>" Processes viewport
    When I sign in to Processes through the local dummy provider
    Then I should see the "Purchase Request" process
    Given the initial process pull is held with a "empty" result
    When I switch the Dashboard Role to "/operations/Facilities"
    Then the new Processes scope stays loading without a false empty result
    When I release the initial process pull
    Then Processes finishes with the "empty" result without a false empty flash

    Examples:
      | viewport |
      | desktop  |
      | mobile   |

  Scenario: Role switching confirms a new catalog and warm navigation keeps cached rows
    Given I am using the "desktop" Processes viewport
    When I sign in to Processes through the local dummy provider
    And I switch the Dashboard Role to "/Administrator"
    Then I should see the "Purchase Request" process
    Given the initial process pull is held with a "populated" result
    When I switch the Dashboard Role to "/Employee"
    Then the new Processes scope stays loading without a false empty result
    When I release the initial process pull
    Then Processes finishes with the "populated" result without a false empty flash
    And Processes filter misses describe the active filters
    When I delay process refresh and revisit the cached catalog
    Then cached Processes remain usable during refresh
