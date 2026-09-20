Feature: File Download Permissions
  As a system administrator
  I want only file owners to download their files
  So that uploaded documents are protected by Cedar authorization

  Background:
    Given I am authenticated without roles
    And the database is clean

  Scenario: File owner can download their own file
    Given I am authenticated as provider user "employee@example.com"
    When I upload a file to the test document store
    And I request a download URL for the uploaded file
    Then I should receive a download URL
    When I download the file content
    Then the downloaded content should match the uploaded content

  Scenario: Non-owner cannot download another user's file
    Given I am authenticated as provider user "employee@example.com"
    When I upload a file to the test document store
    Given I am authenticated as provider user "employee-2@example.com"
    When I attempt to download the uploaded file
    Then I should receive a file authorization error

  Scenario: Cannot download non-existent file
    Given I am authenticated as provider user "employee@example.com"
    When I attempt to download a non-existent file
    Then I should receive a file not found error

  Scenario Outline: Cannot download with invalid file IDs
    Given I am authenticated as provider user "employee@example.com"
    When I attempt to download with an invalid file ID "<invalidFileId>"
    Then I should receive an invalid file ID error

    Examples:
      | invalidFileId           |
      | invalid-file-id         |
      | not-a-valid-id-at-all   |
      | file-                   |
      | 12345                   |

  # Delete file tests
  Scenario: File owner can delete their own file
    Given I am authenticated as provider user "employee@example.com"
    When I upload a file to the test document store
    And I delete the uploaded file
    Then I should receive delete success

  Scenario: Non-owner cannot delete another user's file
    Given I am authenticated as provider user "employee@example.com"
    When I upload a file to the test document store
    Given I am authenticated as provider user "employee-2@example.com"
    When I attempt to delete the uploaded file
    Then I should receive a file authorization error

  Scenario: Delete non-existent file returns success
    Given I am authenticated as provider user "employee@example.com"
    When I delete a non-existent file
    Then I should receive delete success
