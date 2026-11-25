Feature: Mobile shell

  Scenario: Mobile home shows the simplified header, switchboard and working navigation
    Given I am authenticated as provider user "ci@example.com"
    And I use a mobile viewport
    When I visit the home page
    Then I should see the mobile header title "Home"
    And I should not see a mobile header subtitle
    And I should not see the mobile header theme toggle
    When I wait for RxDB to populate local storage
    Then I should see the mobile header title "Home"
    And I should see the mobile home action card "My To-Dos"
    And I should see the mobile home action card "Start process"
    And the mobile home open-task count should match the sidebar todo count
    And the mobile start process card should not show a process count
    And I should not see a visible error boundary
    # The count comparison opens the drawer.
    When I navigate to the "Processes" page from the mobile navigation drawer
    Then the mobile navigation drawer should be closed
    And I should see the mobile header title "Processes"
