Feature: Processes

  Scenario: Authenticated user can see processes
    Given I am authenticated as provider user "ci@example.com"
    When I visit the processes page
    Then I should see the "Purchase Request" process

  Scenario: Authenticated user can open a process from the mobile catalog row
    Given I am authenticated as provider user "ci@example.com"
    And I am using a mobile viewport
    When I visit the processes page
    Then I should see the mobile processes catalog
    When I open the "Purchase Request" process from the mobile catalog row
    Then I should be on a process start page

  Scenario: Authenticated user can start a process from the mobile catalog action
    Given I am authenticated as provider user "ci@example.com"
    And I am using a mobile viewport
    When I visit the processes page
    Then I should see the mobile processes catalog
    When I start the "Purchase Request" process from the mobile catalog action
    Then I should be on a process start page
