@artifact-safety
Feature: Delegation secret artifact safety
  Scenario: Failure artifacts cannot disclose a visible secret
    Given I force a failure after verifying secret-safe clipboard cleanup
