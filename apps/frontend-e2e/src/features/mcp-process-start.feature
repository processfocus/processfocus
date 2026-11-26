@localhost-only
Feature: Discover and start a Process over public MCP

  @timeout:180000
  Scenario: A Process starter can inspect a form and recover a lost submission response
    Given I am authenticated as provider user "employee-finance-manager@example.com" with roles "/Employee,/finance/Manager"
    Then MCP can inspect, start and recover an authorised Process without duplicating it
