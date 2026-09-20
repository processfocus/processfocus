Feature: Request Time
  As a developer
  I want to verify that request timestamps are accurate
  So that scheduled flows and audit trails work correctly

  Background:
    Given I am authenticated without roles

  Scenario: Mutation timestamp should reflect actual request time
    # This test verifies that the server captures a fresh timestamp for each request,
    # not a stale timestamp from server startup. A bug where _requestTime was captured
    # at server startup caused scheduled flows to execute immediately instead of waiting.
    #
    # We wait 10 seconds after authentication to ensure the server has been running
    # long enough that a stale startup timestamp would be noticeably wrong.
    Given I am authenticated with the "/Employee" role
    And I wait 10 seconds
    When I start a time off request for dates "2026-03-15 to 2026-03-20"
    Then the mutation timestamp should be within 5 seconds of now
