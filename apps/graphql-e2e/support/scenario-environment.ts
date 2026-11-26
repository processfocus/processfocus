import type { ITestCaseHookParameter } from "@cucumber/cucumber"

/** Apply the same environment selection before preparing users and running steps. */
export const runsInThisEnvironment = ({
  tags,
}: ITestCaseHookParameter["pickle"]) =>
  !tags.some(
    ({ name }) =>
      (name === "@localhost-only" && !!process.env["BASE_URL"]) ||
      (name === "@oidc-only" && process.env["PF_AUTH_MODE"] !== "oidc"),
  )
