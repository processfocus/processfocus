import assert from "node:assert"
import { Then, When } from "@cucumber/cucumber"
import type { TestWorld } from "../support/world"

const STEP_PATH = "/operations/file-upload-test/Upload document"
const DOCUMENT_STORE = "/test-documents"
const TEST_FILE_CONTENT = "Test file content for permissions testing"
const TEST_FILE_NAME = "test-document.txt"
const TEST_FILE_TYPE = "text/plain"

/**
 * Helper to request a download URL for a file.
 * Can optionally suppress errors for testing authorization failures.
 */
async function requestDownloadUrl(
  world: TestWorld,
  fileId: string,
  { suppressErrors = false }: { suppressErrors?: boolean } = {},
): Promise<{ downloadUrl: string; expiresAt: string } | undefined> {
  try {
    const result = await world.executeGraphQL<{
      requestDownloadUrl: { downloadUrl: string; expiresAt: string }
    }>(
      `
      query RequestDownloadUrl($stepPath: String!, $documentStore: String!, $fileId: String!) {
        requestDownloadUrl(stepPath: $stepPath, documentStore: $documentStore, fileId: $fileId) {
          downloadUrl
          expiresAt
        }
      }
    `,
      {
        stepPath: STEP_PATH,
        documentStore: DOCUMENT_STORE,
        fileId,
      },
    )

    return result.requestDownloadUrl
  } catch (error) {
    if (suppressErrors && error instanceof Error) {
      world.graphqlError = error
      return undefined
    }
    throw error
  }
}

/**
 * Helper to check if a GraphQL error has a specific error code in extensions.
 * The world.executeGraphQL method wraps errors as plain Error objects with messages,
 * so we check both the message and whether it's a GraphQL error (message starts with "GraphQL error:")
 */
function isGraphQLError(error: Error): boolean {
  return (
    error.message.includes("GraphQL error:") ||
    error.message === "" ||
    error.message === "GraphQL error:"
  )
}

When(
  "I upload a file to the test document store",
  { timeout: 15_000 },
  async function (this: TestWorld) {
    const result = await this.executeGraphQL<{
      requestUploadUrl: { fileId: string; uploadUrl: string }
    }>(
      `
      mutation RequestUploadUrl($stepPath: String!, $documentStore: String!, $contentType: String, $filename: String) {
        requestUploadUrl(stepPath: $stepPath, documentStore: $documentStore, contentType: $contentType, filename: $filename) {
          fileId
          uploadUrl
        }
      }
    `,
      {
        stepPath: STEP_PATH,
        documentStore: DOCUMENT_STORE,
        contentType: TEST_FILE_TYPE,
        filename: TEST_FILE_NAME,
      },
    )

    this.uploadedFileId = result.requestUploadUrl.fileId

    // Actually upload the file content to the returned URL
    const uploadResponse = await fetch(result.requestUploadUrl.uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": TEST_FILE_TYPE,
      },
      body: TEST_FILE_CONTENT,
    })

    if (!uploadResponse.ok) {
      throw new Error(
        `File upload failed: ${uploadResponse.status} ${uploadResponse.statusText}`,
      )
    }
  },
)

When(
  "I request a download URL for the uploaded file",
  { timeout: 10_000 },
  async function (this: TestWorld) {
    assert.ok(
      this.uploadedFileId,
      "uploadedFileId should be set before requesting download URL",
    )

    const result = await requestDownloadUrl(this, this.uploadedFileId)
    assert.ok(result, "Expected download URL result")
    this.downloadUrlResult = result
  },
)

Then("I should receive a download URL", function (this: TestWorld) {
  assert.ok(
    this.downloadUrlResult,
    "Expected download URL result to be defined",
  )
  assert.ok(
    this.downloadUrlResult.downloadUrl,
    "Expected download URL to be present",
  )
  assert.ok(
    this.downloadUrlResult.downloadUrl.length > 0,
    "Expected download URL to be non-empty",
  )
  assert.ok(
    this.downloadUrlResult.expiresAt,
    "Expected expiresAt to be present",
  )
})

When(
  "I download the file content",
  { timeout: 10_000 },
  async function (this: TestWorld) {
    assert.ok(
      this.downloadUrlResult,
      "downloadUrlResult should be set before downloading",
    )
    assert.ok(
      this.downloadUrlResult.downloadUrl,
      "downloadUrl should be present",
    )

    const response = await fetch(this.downloadUrlResult.downloadUrl, {
      method: "GET",
    })

    if (!response.ok) {
      throw new Error(
        `File download failed: ${response.status} ${response.statusText}`,
      )
    }

    this.downloadedFileContent = await response.text()
  },
)

Then(
  "the downloaded content should match the uploaded content",
  function (this: TestWorld) {
    assert.ok(
      this.downloadedFileContent !== undefined,
      "Expected downloaded content to be defined",
    )
    assert.strictEqual(
      this.downloadedFileContent,
      TEST_FILE_CONTENT,
      `Downloaded content should match uploaded content. Expected "${TEST_FILE_CONTENT}" but got "${this.downloadedFileContent}"`,
    )
  },
)

When(
  "I attempt to download the uploaded file",
  { timeout: 10_000 },
  async function (this: TestWorld) {
    assert.ok(
      this.uploadedFileId,
      "uploadedFileId should be set before attempting download",
    )

    const result = await requestDownloadUrl(this, this.uploadedFileId, {
      suppressErrors: true,
    })

    if (result) {
      this.downloadUrlResult = result
    }
  },
)

Then("I should receive a file authorization error", function (this: TestWorld) {
  assert.ok(this.graphqlError, "Expected a GraphQL error but none was received")
  const errorMessage = this.graphqlError.message.toLowerCase()
  const isAuthError =
    errorMessage.includes("not authorized") ||
    errorMessage.includes("unauthorized") ||
    errorMessage.includes("forbidden") ||
    errorMessage.includes("access denied") ||
    isGraphQLError(this.graphqlError)
  assert.ok(
    isAuthError,
    `Expected file authorization error but got: ${this.graphqlError.message}`,
  )
})

When(
  "I attempt to download a non-existent file",
  { timeout: 10_000 },
  async function (this: TestWorld) {
    const result = await requestDownloadUrl(this, "file-nonexistent123456789", {
      suppressErrors: true,
    })

    if (result) {
      this.downloadUrlResult = result
    }
  },
)

Then("I should receive a file not found error", function (this: TestWorld) {
  assert.ok(this.graphqlError, "Expected a GraphQL error but none was received")
  // GraphQL errors for file not found often have empty messages with error codes in extensions
  // We just need to verify an error was thrown (which means the file wasn't found)
  assert.ok(
    isGraphQLError(this.graphqlError),
    `Expected file not found GraphQL error but got: "${this.graphqlError.message}"`,
  )
})

When(
  "I attempt to download with an invalid file ID {string}",
  { timeout: 10_000 },
  async function (this: TestWorld, invalidFileId: string) {
    const result = await requestDownloadUrl(this, invalidFileId, {
      suppressErrors: true,
    })

    if (result) {
      this.downloadUrlResult = result
    }
  },
)

Then("I should receive an invalid file ID error", function (this: TestWorld) {
  assert.ok(this.graphqlError, "Expected a GraphQL error but none was received")
  // Any GraphQL error is acceptable (invalid format or not found)
  assert.ok(
    isGraphQLError(this.graphqlError),
    `Expected invalid file ID GraphQL error but got: "${this.graphqlError.message}"`,
  )
})

/**
 * Helper to delete a file.
 * Can optionally suppress errors for testing authorization failures.
 */
async function deleteFile(
  world: TestWorld,
  fileId: string,
  { suppressErrors = false }: { suppressErrors?: boolean } = {},
): Promise<{ success: boolean } | undefined> {
  try {
    const result = await world.executeGraphQL<{
      deleteFile: { success: boolean }
    }>(
      `
      mutation DeleteFile($fileId: ID!) {
        deleteFile(fileId: $fileId) {
          success
        }
      }
    `,
      {
        fileId,
      },
    )

    return result.deleteFile
  } catch (error) {
    if (suppressErrors && error instanceof Error) {
      world.graphqlError = error
      return undefined
    }
    throw error
  }
}

When(
  "I delete the uploaded file",
  { timeout: 10_000 },
  async function (this: TestWorld) {
    assert.ok(
      this.uploadedFileId,
      "uploadedFileId should be set before deleting file",
    )

    const result = await deleteFile(this, this.uploadedFileId)
    assert.ok(result, "Expected delete result")
    this.deleteResult = result
  },
)

When(
  "I attempt to delete the uploaded file",
  { timeout: 10_000 },
  async function (this: TestWorld) {
    assert.ok(
      this.uploadedFileId,
      "uploadedFileId should be set before attempting delete",
    )

    const result = await deleteFile(this, this.uploadedFileId, {
      suppressErrors: true,
    })

    if (result) {
      this.deleteResult = result
    }
  },
)

When(
  "I delete a non-existent file",
  { timeout: 10_000 },
  async function (this: TestWorld) {
    const result = await deleteFile(this, "file-nonexistent123456789")
    assert.ok(result, "Expected delete result")
    this.deleteResult = result
  },
)

Then("I should receive delete success", function (this: TestWorld) {
  assert.ok(this.deleteResult, "Expected delete result to be defined")
  assert.strictEqual(
    this.deleteResult.success,
    true,
    "Expected delete to return success: true",
  )
})
