@localhost-only
Feature: Embedded forms

  Scenario: Anonymous visitor can submit the calculator demo as an embedded form
    Given I am not logged in
    When I open a host page with the embedded calculator form
    Then I should see the embedded calculator form inside the iframe
    When I fill in the embedded calculator form with first number "7" and second number "8"
    And I submit the embedded calculator form
    Then I should see the embedded calculator thank-you state
    And the host page should receive the embedded calculator lifecycle events

  Scenario: Submitted embedded form scrolls the host page to the success state
    Given I am not logged in
    When I open a host page with the embedded calculator form below a spacer
    Then I should see the embedded calculator form inside the iframe
    When I fill in the embedded calculator form with first number "3" and second number "4"
    And I submit the embedded calculator form
    Then I should see the embedded calculator thank-you state
    And the host page should scroll to the embedded calculator success state
