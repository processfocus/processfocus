Feature: Provider User login in an SSO-only organisation
  Scenario: Real SSO sessions retain human provenance and user ownership
    Given I sign in through the controlled Google provider
    Then my SSO session preserves user ownership

  Scenario Outline: Failed provider authentication cannot create a usable session
    When the controlled provider returns "<evidence>"
    Then SSO rejects it with "<error>" and leaves no usable session

    Examples:
      | evidence          | error                  |
      | Invalid signature | OAuth2 callback failed |
      | Invalid nonce     | OAuth2 callback failed |
      | Deny sign-in      | access_denied          |
