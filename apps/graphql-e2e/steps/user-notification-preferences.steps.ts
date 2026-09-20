import assert from "node:assert"
import { Then, When } from "@cucumber/cucumber"
import { sleep } from "../support/sleep"
import type { TestWorld } from "../support/world"

const updateNotificationPreferencesMutation = `
  mutation UpdateNotificationPreferences(
    $userId: ID!
    $preferences: NotificationPreferencesInput!
  ) {
    updateNotificationPreferences(
      userId: $userId
      preferences: $preferences
    ) {
      __typename
      ... on UpdateNotificationPreferencesSuccess {
        preferences {
          notifications {
            todoAssignment {
              email
            }
          }
        }
      }
      ... on UpdateNotificationPreferencesFailure {
        error
      }
    }
  }
`

const setTaskAssignmentEmail = async (world: TestWorld, email: boolean) => {
  assert.ok(world.selectedUserId, "Expected a selected user ID")

  const maxAttempts = 4

  for (let attempt = 1; ; attempt++) {
    const result = await world.executeGraphQL<{
      updateNotificationPreferences:
        | {
            __typename: "UpdateNotificationPreferencesSuccess"
            preferences: {
              notifications: {
                todoAssignment: {
                  email: boolean
                }
              }
            }
          }
        | {
            __typename: "UpdateNotificationPreferencesFailure"
            error: string
          }
    }>(updateNotificationPreferencesMutation, {
      userId: world.selectedUserId,
      preferences: {
        notifications: {
          todoAssignment: {
            email,
          },
        },
      },
    })

    const updateResult = result.updateNotificationPreferences
    if (updateResult.__typename === "UpdateNotificationPreferencesSuccess") {
      world.notificationPreferencesResult = updateResult.preferences
      return
    }

    if (
      updateResult.error === "Failed to update notification preferences" &&
      attempt < maxAttempts
    ) {
      await sleep(150 * attempt)
      continue
    }

    assert.fail(updateResult.error)
  }
}

const queryNotificationPreferences = async (world: TestWorld) => {
  assert.ok(world.selectedUserId, "Expected a selected user ID")

  const expectedEmail =
    world.notificationPreferencesResult?.notifications.todoAssignment.email
  const maxAttempts = expectedEmail === undefined ? 1 : 4

  for (let attempt = 1; ; attempt++) {
    const result = await world.executeGraphQL<{
      notificationPreferences: {
        notifications: {
          todoAssignment: {
            email: boolean
          }
        }
      }
    }>(
      `
        query NotificationPreferences($userId: ID!) {
          notificationPreferences(userId: $userId) {
            notifications {
              todoAssignment {
                email
              }
            }
          }
        }
      `,
      { userId: world.selectedUserId },
    )

    world.notificationPreferencesResult = result.notificationPreferences

    if (
      expectedEmail === undefined ||
      result.notificationPreferences.notifications.todoAssignment.email ===
        expectedEmail ||
      attempt >= maxAttempts
    ) {
      return
    }

    await sleep(150 * attempt)
  }
}

When("I select the authenticated user", function (this: TestWorld) {
  const userId = this.getAuthenticatedUserId()
  assert.ok(userId, "Expected an authenticated user ID")
  this.selectedUserId = userId
})

When(
  "I query notification preferences for the selected user",
  async function (this: TestWorld) {
    await queryNotificationPreferences(this)
  },
)

When(
  "I enable task assignment email notifications for the selected user",
  async function (this: TestWorld) {
    await setTaskAssignmentEmail(this, true)
  },
)

When(
  "I disable task assignment email notifications for the selected user",
  async function (this: TestWorld) {
    await setTaskAssignmentEmail(this, false)
  },
)

Then(
  "task assignment email notifications should be disabled",
  function (this: TestWorld) {
    assert.ok(
      this.notificationPreferencesResult,
      "Expected notification preferences result",
    )
    assert.strictEqual(
      this.notificationPreferencesResult.notifications.todoAssignment.email,
      false,
    )
  },
)

Then(
  "task assignment email notifications should be enabled",
  function (this: TestWorld) {
    assert.ok(
      this.notificationPreferencesResult,
      "Expected notification preferences result",
    )
    assert.strictEqual(
      this.notificationPreferencesResult.notifications.todoAssignment.email,
      true,
    )
  },
)
