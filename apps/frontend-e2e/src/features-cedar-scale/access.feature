@localhost-only
Feature: Cedar access at policy scale

  Scenario: A large policy set fits the hosted handbook request budget
    Given I am authenticated as provider user "ci@example.com"
    When I warm the Cedar route using the schema page
    Then the Cedar access handbook should load within the hosted request budget
    When I select the Cedar principal "frontend"
    Then I should see the Cedar principal heading "frontend"
