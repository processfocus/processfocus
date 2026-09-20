@without-waiting
Feature: Execute onboarding without scheduled waits
  Background:
    Given I am authenticated without roles
    And the database is clean

  Scenario Outline: Onboarding retains dependencies and completes either review outcome
    When I walk onboarding without waiting with performance outcome "<outcome>"
    Examples:
      | outcome |
      | passed  |
      | failed  |

  Scenario: Mode permission is additional to normal start authorization
    When I attempt onboarding without waiting without its start role
    Then no rejected execution or scheduled work exists

  Scenario: Ordinary starts work while unauthorized mode selection is rejected
    Given I am authenticated with the "/Employee" role
    When I attempt a purchase request without waiting
    Then no rejected execution or scheduled work exists
    When I start a purchase request for item "Ordinary" with value "150"
    And I wait for flow to advance
