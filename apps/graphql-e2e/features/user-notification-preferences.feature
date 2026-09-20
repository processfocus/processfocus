Feature: User notification preferences
  As an administrator
  I want to manage task assignment email notifications for a user
  So that notifications are opt-in and editable through GraphQL

  Background:
    Given I am authenticated without roles

  Scenario: Notification preferences default to off and can be enabled
    When I select the authenticated user
    And I query notification preferences for the selected user
    Then task assignment email notifications should be disabled
    When I enable task assignment email notifications for the selected user
    Then task assignment email notifications should be enabled
    When I query notification preferences for the selected user
    Then task assignment email notifications should be enabled
    When I disable task assignment email notifications for the selected user
    Then task assignment email notifications should be disabled
    When I query notification preferences for the selected user
    Then task assignment email notifications should be disabled
