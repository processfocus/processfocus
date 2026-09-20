Feature: Organisation Query
  As an authenticated user
  I want to query the organisation
  So that I can see org details

  Background:
    Given I am authenticated without roles

  Scenario: Query org returns correct name and acronym
    When I query the org
    Then the org name should be "Demo Org"
    And the org acronym should be "Demo"

  Scenario: Query orgLevels returns ordered levels for the demo org
    When I query the org levels
    Then the org levels should include organisation at maxDepth 1
    And the org levels should include department at maxDepth 2
    And the org levels should include team at maxDepth 3
    And the org levels should be ordered by maxDepth ascending
