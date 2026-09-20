@localhost-only
Feature: Frontend boot health

  The deployed Dashboard exposes a stable, unauthenticated, data-free browser
  health surface that boots the real organisation frontend plugin
  composition. The demo organisation runs without frontend plugins, so the
  ready marker must appear after the (empty) plugin composition boots.

  Scenario: Anonymous visitor sees the ready marker after the plugin composition boots
    Given I am not logged in
    When I open the frontend boot health page
    Then the frontend boot health marker reports "ready"
