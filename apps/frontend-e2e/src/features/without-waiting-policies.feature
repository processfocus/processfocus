@localhost-only
Feature: Process-specific Without Waiting controls
  Scenario Outline: The selected process determines mode availability
    Given I use the disposable <grant> browser account without Administrator permission
    Then the "<grant>" grant shows process-specific submission controls
    Examples:
      | grant         |
      | exact-process |
      | hierarchy     |
      | broad         |
