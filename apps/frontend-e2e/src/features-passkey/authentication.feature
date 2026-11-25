Feature: Reusable normally authenticated test users
  Scenario: Invited users reuse normal login in the browser and API without sharing sessions
    Given two isolated invited Passkey users have registered and signed in again
    Then each Passkey user can perform protected browser and API work
    When the first Passkey user's session is lost
    Then normal Passkey login reacquires API access without affecting the other user

  Scenario: A registered device survives a later fixture failure
    Then a failed post-registration logout retains a device for normal login
