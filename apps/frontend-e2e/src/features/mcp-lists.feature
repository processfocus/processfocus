@localhost-only
Feature: Browse Lists and start related work over public MCP

  @timeout:180000
  Scenario: Discover Purchase Orders and start one related Process with View and act
    Given I am authenticated as provider user "employee-finance-manager@example.com" with roles "/Employee,/finance/Manager"
    And I prepare a purchase request for matching order "Desk"
    When I visit the processes page
    And I wait for RxDB to populate local storage
    And I start the "Purchase Request" process
    And I fill the purchase request with a scenario-unique item and cost
    And I submit the process form
    And I visit the to-dos page
    And I open the uniquely created approval todo
    And I check I approve and complete the todo
    Given I prepare a purchase request for matching order "Chair"
    When I visit the processes page
    And I start the "Purchase Request" process
    And I fill the purchase request with a scenario-unique item and cost
    And I submit the process form
    And I visit the to-dos page
    And I open the uniquely created approval todo
    And I check I approve and complete the todo
    Then a view-only MCP client can filter and inspect the matching Purchase Orders
    And the Purchase Request starts once through MCP with its selected order in the form context
    And a selected row on "browse-only" can start a Purchase Request through MCP without detail access
    And a selected row on "restricted-detail" can start a Purchase Request through MCP without detail access
    And an MCP client without List access cannot discover or inspect those orders
