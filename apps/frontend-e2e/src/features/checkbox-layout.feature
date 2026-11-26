Feature: Shared Boolean form layout
  Scenario Outline: Compact labelled checkboxes at <width> pixels
    Given I open the shared checkbox form at <width> pixels
    Then checkbox labels sit beside compact controls and wrap naturally
    And checkbox labels and Space toggle the checked state
    And the disabled checkbox retains its checked state

    Examples:
      | width |
      | 1280  |
      | 320   |
