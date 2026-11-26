import { expect } from "@playwright/test"
import { Then, When, test } from "./fixtures"

When(
  "I create and edit an invitation through the schema form",
  async ({ page, context }) => {
    test.setTimeout(120_000)
    // The invitation schema accepts Unicode local parts; native email inputs
    // reject them. Exercise the schema contract through real form submission.
    const email = `invitation-form-é-${Date.now()}@example.com`
    let saves = 0
    page.on("request", (request) => {
      if (/mutation (Create|Update)Invitation\b/.test(request.postData() ?? ""))
        saves++
    })
    await page.goto("/settings/invitations/new")
    const input = page.getByRole("textbox", { name: /^Email/ })
    const create = page.getByRole("button", {
      name: "Create Invitation",
      exact: true,
    })
    await create.click()
    await expect(
      page.getByText("Email is required", { exact: true }),
    ).toBeVisible()
    await expect(input).toBeFocused()
    await input.fill("invalid")
    await create.click()
    await expect(
      page.getByText("Enter a valid email address", { exact: true }),
    ).toBeVisible()
    await input.fill(`  ${email}  `)
    await create.click()
    await expect(
      page.getByText("Select at least one role", { exact: true }),
    ).toBeVisible()
    expect(saves).toBe(0)
    await page.getByRole("checkbox", { name: /Administrator/ }).check()
    await create.click()
    await expect(page).toHaveURL(/\/settings\/invitations$/)
    await page.getByRole("row").filter({ hasText: email }).click()
    await expect(input).toHaveValue(email)
    await expect(
      page.getByRole("checkbox", { name: /Administrator/ }),
    ).toBeChecked()
    const detailUrl = page.url()

    // A server-result failure must leave the actual renderer's values editable.
    const failure = Promise.withResolvers<void>()
    await page.route("**/graphql", async (route) => {
      if (
        /mutation UpdateInvitation\b/.test(route.request().postData() ?? "")
      ) {
        await failure.promise
        await route.fulfill({
          json: {
            data: {
              updateInvitation: {
                __typename: "SaveInvitationFailure",
                error: "Please retry this invitation save",
              },
            },
          },
        })
      } else await route.continue()
    })
    const updated = email.replace("invitation-form-", "edited-invitation-")
    await input.fill(updated)
    await page.getByRole("button", { name: "Save", exact: true }).click()
    await expect(
      page.getByRole("button", { name: "Saving...", exact: true }),
    ).toBeDisabled()
    await expect(input).toBeDisabled()
    await expect(
      page.getByRole("button", { name: "Delete Invitation", exact: true }),
    ).toBeDisabled()
    failure.resolve()
    await expect(
      page.getByText("Please retry this invitation save", { exact: true }),
    ).toBeVisible()
    await expect(input).toHaveValue(updated)
    await expect(page).toHaveURL(detailUrl)
    await page.unroute("**/graphql")
    await input.press("Enter")
    await expect(page).toHaveURL(/\/settings\/invitations$/)
    await page.getByRole("row").filter({ hasText: updated }).click()
    await expect(page).toHaveURL(detailUrl)
    await expect(input).toHaveValue(updated)
    await page.reload()
    await expect(input).toHaveValue(updated)

    // Independent API read, bypassing the detail query's browser cache.
    const detailRequest = page.waitForRequest((request) =>
      /query InvitationDetail\b/.test(request.postData() ?? ""),
    )
    await page.reload()
    const request = await detailRequest
    const response = await context.request.post(request.url(), {
      data: request.postDataJSON(),
      headers: { origin: new URL(page.url()).origin },
    })
    const body = await response.json()
    expect(body.errors).toBeUndefined()
    expect(body.data.invitationDetail.email).toBe(updated)
    expect(body.data.invitationDetail.roles).toHaveLength(1)

    await input.fill("abandoned@example.com")
    await page.getByRole("link", { name: "Back to Invited Users" }).click()
    await expect(page).toHaveURL(/\/settings\/invitations$/)
    await page.goBack()
    await expect(page).toHaveURL(detailUrl)
    await expect(input).toHaveValue(updated)
    await expect(
      page.getByRole("checkbox", { name: /Administrator/ }),
    ).toBeChecked()
  },
)

Then("the invitation can be deleted from its detail page", async ({ page }) => {
  await page
    .getByRole("button", { name: "Delete Invitation", exact: true })
    .click()
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Delete Invitation", exact: true })
    .click()
  await expect(page).toHaveURL(/\/settings\/invitations$/)
})
