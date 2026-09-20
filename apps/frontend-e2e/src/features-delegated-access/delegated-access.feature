@localhost-only @delegated-access
Feature: Delegation issuance with a genuine human passkey
  Scenario: An authorized Administrator can issue tokens while an ordinary user is denied
    Given I register a real virtual passkey in the disposable delegation organisation
    When I open Act on behalf from my profile menu
    And I create and replace delegation secrets without reauthentication on desktop and mobile
    Then my delegation records survive a reload without revealing their secrets
    And an ordinary human has no token-management entry and direct API access is denied
