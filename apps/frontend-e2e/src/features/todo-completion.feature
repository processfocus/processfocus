@todo-completion
Feature: Authenticated state-aware todo completion

  # Authentication, queued work, form validation and persisted refresh each need time.
  @timeout:180000
  Scenario Outline: Validate and persist a Purchase Request manager approval in a <surface> form
    Given I observe the authenticated completion journey
    And I am authenticated as provider user "employee-finance-manager@example.com" with roles "/Employee,/finance/Manager" using client "e2e-employee-finance-manager"
    When I visit the processes page
    And I wait for RxDB to populate local storage
    And I start the "Purchase Request" process
    And I fill the purchase request with a scenario-unique item and cost
    And I submit the process form
    And I visit the to-dos page
    And I open the uniquely created approval todo
    And I view the approval in a "<surface>" form
    Then the approval form and real metadata contain the state-aware fields
    When I submit the approval without checking I approve
    Then approval validation prevents a completion mutation
    When my unsaved approval survives back and forward in the "<surface>" form
    And I check I approve and complete the todo
    Then the generated approval mutation succeeds
    And the created approval remains absent after a hard refresh
    And the browser has no AJV schema warnings

    Examples:
      | surface   |
      | modal     |
      | full-page |
