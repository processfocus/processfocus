@artifact-safety
Feature: Delegation secret artifact safety
  Scenario: Failure artifacts cannot disclose a visible secret
    Given I force a failure after verifying secret-safe clipboard cleanup

  Scenario: Transport failure artifacts cannot disclose a delegated credential
    Given a delegated protected-work request fails during transport
