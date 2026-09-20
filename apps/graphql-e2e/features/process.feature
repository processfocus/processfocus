Feature: Process List
  As an authenticated M2M client
  I want to verify process authorization
  So that unauthorized clients cannot see processes

  Scenario: Unauthorized client receives no processes
    Given I am authenticated without roles
    When I query for processes with limit 100
    Then I should receive zero processes

  Scenario: Provider user can see processes
    Given I am authenticated with the "/Employee" role
    When I query for processes with limit 100
    Then I should receive at least one process

  Scenario: Invalid role scope returns error
    When I authenticate with the "/NonExistentRole" role
    Then I should receive an invalid_scope error
