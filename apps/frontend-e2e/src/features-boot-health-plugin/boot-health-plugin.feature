@localhost-only
Feature: Frontend boot health with a healthy plugin composition

  The runtime is started with a temporary organisation whose analytics
  browser plugin artifact imports, activates, and renders successfully, so
  the boot health surface must report the ready marker and show the
  plugin-rendered output.

  Scenario: Healthy plugin composition reports ready and renders the plugin
    Given I am not logged in
    When I open the frontend boot health page
    Then the frontend boot health marker reports "ready"
    And the frontend boot health page shows the rendered analytics plugin
