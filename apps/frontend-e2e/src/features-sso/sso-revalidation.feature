@localhost-only
Feature: Periodic upstream SSO revalidation
  Scenario: An active Dashboard returns to the same deep link hands-free
    Given I sign in through the controlled Google provider
    When I stay on a protected deep link until Google revalidation
    Then I am signed in on the same deep link

  Scenario Outline: A returning user can sign in explicitly when revalidation cannot complete
    Given I sign in through the controlled Google provider
    When I reopen a protected deep link after expiry and Google returns "<result>"
    Then Sign In preserves the deep link without retrying Google automatically

    Examples:
      | result      |
      | interaction |
      | deny        |
