Feature: Settings

  Scenario: Cedar explorer scopes a public link to one Todo of a Step
    Given I am authenticated as provider user "ci@example.com"
    When I explore public-link completion in Cedar
    Then the Cedar explorer should deny completion
    When I set the Cedar completion Todo ID to "prototype-link"
    Then the Cedar explorer should allow completion
    When I set the Cedar completion Todo ID to "another-todo"
    Then the Cedar explorer should deny completion

  # Deployed CI workload identities cannot administer invitations.
  @localhost-only
  Scenario: Invitation editor validates, retries and discards abandoned edits
    Given I am authenticated as provider user "ci@example.com"
    When I create and edit an invitation through the schema form
    Then the invitation can be deleted from its detail page

  Scenario Outline: Authorised user can read effective Cedar access from a direct URL
    Given I am authenticated as provider user "ci@example.com"
    When I visit the Cedar access page at "<path>"
    Then I should see the Cedar access handbook
    When I select the Cedar principal "frontend"
    Then I should see the Cedar principal heading "frontend"
    When I select the Cedar principal "Public link"
    Then I should see the Cedar principal heading "Public link"

    Examples:
      | path                    |
      | /settings/cedar         |
      | /settings/cedar/access   |

  # Each navigation waits for settings data; the history round-trip can exceed 60s.
  @timeout:120000
  Scenario: Administrator can browse settings tables and open a user detail
    Given I am authenticated as provider user "ci@example.com"
    When I visit the settings page
    Then I should see settings users table data
    And the active settings section should be "Users" at "/settings/users"
    When I open the Roles settings table and check that only Roles rows are requested
    And the active settings section should be "Roles" at "/settings/roles"
    When I open the "Invited Users" settings table
    Then I should see settings invitations table data
    And the active settings section should be "Invited Users" at "/settings/invitations"
    When I open the "Authentication Providers" settings table
    Then I should see settings providers table data
    And the active settings section should be "Authentication Providers" at "/settings/providers"
    When I go back in settings history
    Then the active settings section should be "Invited Users" at "/settings/invitations"
    And I should see settings invitations table data
    When I go back to Roles while its rows and counts are refreshing
    Then the active settings section should be "Roles" at "/settings/roles"
    And I should see settings roles table data
    When I go back in settings history
    Then the active settings section should be "Users" at "/settings/users"
    And I should see settings users table data
    When I go forward in settings history
    Then the active settings section should be "Roles" at "/settings/roles"
    And I should see settings roles table data
    When I go forward in settings history
    Then the active settings section should be "Invited Users" at "/settings/invitations"
    And I should see settings invitations table data
    When I go forward in settings history
    Then the active settings section should be "Authentication Providers" at "/settings/providers"
    And I should see settings providers table data
    When I open the "Users" settings table
    And I open the settings user row for "ci@example.com"
    Then I should see the settings user detail for "ci@example.com"

  Scenario: Failed section counts are not reported as zero
    Given I am authenticated as provider user "ci@example.com"
    And the settings "SettingsCounts" request fails
    When I visit the settings section at "/settings/roles"
    Then settings should show a count error without inactive badges

  @timeout:120000
  Scenario Outline: Failed Settings refresh does not show an invalid cached badge
    Given I am authenticated as provider user "ci@example.com"
    When I visit the settings page
    Then I should see settings users table data
    When I open the Roles settings table and check that only Roles rows are requested
    And I open the "Users" settings table
    Then I should see settings users table data
    Given the settings "<operation>" request fails
    When I go back in settings history
    Then settings should show "<error>" without a badge on "<section>"

    Examples:
      | operation        | error                                   | section |
      | SettingsCounts   | Could not load settings section counts. | Users   |
      | AllSettingsRoles | Settings request unavailable            | Roles   |

  Scenario Outline: Settings sections support direct entry, reload and a new tab
    Given I am authenticated as provider user "ci@example.com"
    When I visit the settings section at "<path>"
    Then the active settings section should be "<section>" at "<path>"
    And I should see settings <table> table data
    When I reload the settings section
    Then the active settings section should be "<section>" at "<path>"
    And I should see settings <table> table data
    When I open the settings section in a new tab showing "<record>"
    Then the active settings section should be "<section>" at "<path>"
    And I should see settings <table> table data

    Examples:
      | section                  | path                  | table       | record                   |
      | Users                    | /settings/users       | users       | ci@example.com           |
      | Invited Users            | /settings/invitations | invitations | settings-e2e@example.com |
      | Roles                    | /settings/roles       | roles       | Administrator            |
      | Authentication Providers | /settings/providers   | providers   | google                   |

  @localhost-only
  Scenario: Provider-only administrator enters settings and cannot access user administration
    Given I authenticate the settings fixture "settings-providers@example.com"
    When I visit the settings page
    Then the active settings section should be "Authentication Providers" at "/settings/providers"
    And I should see settings providers table data
    And the "Users" settings link should be hidden
    And the "Invited Users" settings link should be hidden
    And the "Roles" settings link should be hidden
    When I visit the settings section at "/settings/users"
    Then settings access should be denied
    When I visit the settings section at "/settings/invitations"
    Then settings access should be denied
    When I visit the settings section at "/settings/roles"
    Then settings access should be denied

  @localhost-only
  Scenario: User-only administrator cannot access provider administration
    Given I authenticate the settings fixture "settings-users@example.com"
    When I visit the settings page
    Then the active settings section should be "Users" at "/settings/users"
    And the settings user row for "settings-users@example.com" should be visible
    And the "Authentication Providers" settings link should be hidden
    When I open the "Invited Users" settings table
    Then I should see settings invitations table data
    When I open the "Roles" settings table
    Then I should see settings roles table data
    When I visit the settings section at "/settings/providers"
    Then settings access should be denied

  @localhost-only
  Scenario: User without settings permissions cannot enter settings
    Given I authenticate the settings fixture "employee@example.com"
    When I visit the settings page
    Then settings access should be denied
    When I visit the settings section at "/settings/users"
    Then settings access should be denied
    When I visit the settings section at "/settings/invitations"
    Then settings access should be denied
    When I visit the settings section at "/settings/roles"
    Then settings access should be denied
    When I visit the settings section at "/settings/providers"
    Then settings access should be denied
