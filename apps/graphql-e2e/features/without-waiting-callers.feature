@without-waiting-callers @localhost-only
Feature: Without Waiting policies authorize actual callers and generated starts
  Background:
    Given I am authenticated without roles
    And the database is clean

  Scenario Outline: Process capabilities and starts agree with scoped Cedar grants
    When the "<caller>" caller exercises the "<scope>" schedule grant through both start shapes
    Examples:
      | caller     | scope     |
      | service    | exact     |
      | service    | hierarchy |
      | service    | broad     |
      | human      | exact     |
      | human      | hierarchy |
      | human      | broad     |
      | human      | default   |
      | delegation | exact     |
      | delegation | hierarchy |
      | delegation | broad     |

  Scenario Outline: Automation requires an explicit mode grant and valid input
    When the "<caller>" caller cannot select ungranted or invalid schedule modes
    Examples:
      | caller     |
      | service    |
      | delegation |

  Scenario Outline: Mode permission cannot replace ordinary start permission
    When the "<caller>" caller has mode permission but cannot bypass ordinary start authorization
    Examples:
      | caller     |
      | service    |
      | human      |
      | delegation |
