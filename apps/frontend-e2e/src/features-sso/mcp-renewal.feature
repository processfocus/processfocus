@localhost-only
Feature: Renew an MCP connection after the SSO window expires

  @timeout:180000
  Scenario: Fresh upstream sign-in retains the existing MCP grant
    Then MCP renewal stops at the SSO deadline and fresh sign-in restores the same access
