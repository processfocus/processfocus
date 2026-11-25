@localhost-only
Feature: Work on actionable To-Dos over public MCP

  @timeout:180000
  Scenario: A Passkey user connects a client and discovers work under their own authority
    Given I observe the authenticated completion journey
    And I am authenticated as provider user "employee-finance-manager@example.com" with roles "/Employee,/finance/Manager"
    When I visit the processes page
    And I wait for RxDB to populate local storage
    And I start the "Purchase Request" process
    And I fill the purchase request with a scenario-unique item and cost
    And I submit the process form
    And I visit the to-dos page
    And I open the uniquely created approval todo
    Then MCP renewal and disconnect leave the other client and Dashboard session working
    And an acting MCP client completes that approval only after confirmation and recovers a lost reply
    And the created approval remains absent after a hard refresh
