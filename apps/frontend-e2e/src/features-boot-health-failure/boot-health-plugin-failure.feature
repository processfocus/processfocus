@localhost-only
Feature: Frontend boot health with a failing plugin composition

  The runtime is started with a temporary organisation whose built browser
  plugin bundle fails at import, so the boot health surface must withhold the
  ready marker and keep the failure observable as a browser error.

  Scenario: Failing plugin composition prevents the ready marker
    Given I am not logged in
    When I open the frontend boot health page
    Then the frontend boot health marker reports "failed"
    And the browser console records a frontend plugin boot failure
