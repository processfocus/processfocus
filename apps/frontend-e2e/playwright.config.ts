import { execFileSync } from "node:child_process"
import { join } from "node:path"
import { workspaceRoot } from "@nx/devkit"
import { nxE2EPreset } from "@nx/playwright/preset"
import { defineConfig, devices } from "@playwright/test"
import { defineBddConfig } from "playwright-bdd"
import { delegationArtifactOptions } from "./src/steps/delegated-access-artifacts"

const findAvailablePort = (startPort: number): number => {
  const output = execFileSync(
    "node",
    [
      "-e",
      `
          const { createServer } = require("node:net")

          const canListen = (port) => new Promise((resolve) => {
            const server = createServer()
            server.once("error", () => resolve(false))
            server.once("listening", () => server.close(() => resolve(true)))
            server.listen(port)
          })

          const isUnused = async (port) => {
            try {
              await fetch("http://localhost:" + port)
              return false
            } catch {
              return canListen(port)
            }
          }

          ;(async () => {
            for (let port = ${startPort}; port < ${startPort + 100}; port += 1) {
              if (await isUnused(port)) {
                process.stdout.write(String(port))
                process.exit(0)
              }
            }

            console.error("No available frontend e2e port found in range ${startPort}-${startPort + 99}")
            process.exit(1)
          })()
        `,
    ],
    { encoding: "utf8" },
  )
  const port = Number.parseInt(output, 10)
  if (!Number.isInteger(port)) {
    throw new Error(`Could not resolve frontend e2e port: ${output}`)
  }
  return port
}

// For CI, you may want to set BASE_URL to the deployed application.
const localFrontendPort =
  process.env["FRONTEND_E2E_PORT"] ?? `${findAvailablePort(3100)}`
const baseURL =
  process.env["BASE_URL"] || `http://localhost:${localFrontendPort}`
const hasExplicitBaseUrl = !!process.env["BASE_URL"]
process.env["BASE_URL"] = baseURL
const reuseExistingServer =
  process.env["PLAYWRIGHT_REUSE_EXISTING_SERVER"] === "1"
const isLocalhost = ["localhost", "127.0.0.1"].includes(
  new URL(baseURL).hostname,
)

if (!hasExplicitBaseUrl) {
  process.env["GOOGLE_CLIENT_ID"] ??= "ci-google-client-id"
  process.env["GOOGLE_CLIENT_SECRET"] ??= "ci-google-client-secret"
  process.env["CI_PIPELINE_SECRET"] ??= "ci-pipeline-secret"
}

const instantE2E = process.env["PF_INSTANT_E2E"] === "1"

const hasExternalFeatures = !!process.env["FRONTEND_E2E_FEATURES"]
const featuresGlob =
  process.env["FRONTEND_E2E_FEATURES"] ??
  (instantE2E
    ? "./src/features-instant/**/*.feature"
    : "./src/features/**/*.feature")
const isDelegationJourney = featuresGlob.includes("features-delegated-access")
if (isDelegationJourney) {
  // Playwright's failure accessibility snapshots are independent of trace capture.
  process.env["PLAYWRIGHT_NO_COPY_PROMPT"] = "1"
}
const bddTags =
  process.env["FRONTEND_E2E_TAGS"] ??
  // Some scenarios rely on localhost-only routes or config. Exclude them from
  // deployed-runtime runs by default, but allow explicit tag overrides.
  (isLocalhost ? undefined : "not @localhost-only")
const requestedBrowsers = new Set(
  (process.env["FRONTEND_E2E_BROWSERS"] ?? "")
    .split(",")
    .map((browser) => browser.trim())
    .filter(Boolean),
)
const validBrowsers = new Set(["chromium", "firefox", "webkit"])
const invalidBrowsers = [...requestedBrowsers].filter(
  (browser) => !validBrowsers.has(browser),
)

if (invalidBrowsers.length > 0) {
  throw new Error(
    `Invalid FRONTEND_E2E_BROWSERS value(s): ${invalidBrowsers.join(", ")}. ` +
      `Expected one or more of: ${[...validBrowsers].join(", ")}.`,
  )
}

const isBrowserEnabled = (browser: string) =>
  requestedBrowsers.size === 0 || requestedBrowsers.has(browser)

const featuresRoot =
  process.env["FRONTEND_E2E_FEATURES_ROOT"] ??
  (hasExternalFeatures ? "../../" : undefined)
const playwrightReportDir = join(
  workspaceRoot,
  "apps/frontend-e2e/playwright-report",
)
const junitReportFile = join(
  workspaceRoot,
  "apps/frontend-e2e/test-results/junit/results.xml",
)

const projects = [
  ...(isBrowserEnabled("chromium")
    ? [
        {
          name: "chromium",
          use: { ...devices["Desktop Chrome"] },
        },
      ]
    : []),

  // Next.js dev mode keeps HMR WebSocket connections open, which prevents the
  // `load` event from firing reliably in Firefox and WebKit. This causes
  // page.goto() to timeout. Disable these browsers for localhost dev servers;
  // they run normally against deployed (production-built) environments.
  ...(isLocalhost
    ? []
    : [
        ...(isBrowserEnabled("firefox")
          ? [
              {
                name: "firefox",
                use: { ...devices["Desktop Firefox"] },
              },
            ]
          : []),
        ...(isBrowserEnabled("webkit")
          ? [
              {
                name: "webkit",
                use: { ...devices["Desktop Safari"] },
              },
            ]
          : []),
      ]),
]

if (projects.length === 0) {
  throw new Error(
    "FRONTEND_E2E_BROWSERS selected no runnable browser projects. " +
      "Firefox and WebKit are only enabled for deployed BASE_URL runs.",
  )
}

const testDir = defineBddConfig({
  features: featuresGlob,
  ...(bddTags ? { tags: bddTags } : {}),
  ...(featuresRoot ? { featuresRoot } : {}),
  steps: "./src/steps/**/*.ts",
})

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  ...nxE2EPreset(__filename, { testDir }),
  // Logout tests wait up to 30s for RxDB population in Background, then need
  // time for the actual logout + redirect. 30s default is too tight on a dev
  // server, so give tests 60s.
  timeout: 60_000,
  ...(hasExplicitBaseUrl ? {} : { workers: 1 }),
  ...(process.env["CI"]
    ? {
        reporter: [
          ["line"],
          ["html", { open: "never", outputFolder: playwrightReportDir }],
          ["junit", { outputFile: junitReportFile }],
        ],
      }
    : {}),
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    baseURL,
    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: "on-first-retry",
    ...(isDelegationJourney ? delegationArtifactOptions : {}),
  },
  /* Run your local dev server before starting the tests (skip if BASE_URL is set) */
  ...(hasExplicitBaseUrl
    ? {}
    : {
        webServer: {
          // Set FRONTEND_PORT via Playwright env (merged with process.env) so
          // the serve child inherits it without Unix `env VAR=value` prefixes.
          command:
            process.env["FRONTEND_E2E_SERVER_COMMAND"] ??
            (instantE2E
              ? `bun run --cwd apps/frontend next start --port ${localFrontendPort}`
              : `bun cli/pfcli/src/run-temp-org.ts examples/demo --copy -- bun scripts/nx-quiet.ts run @processfocus/runtime-local:serve`),
          url: baseURL,
          reuseExistingServer: instantE2E ? false : reuseExistingServer,
          cwd: workspaceRoot,
          // Cold CI boots build the org, import it, and start `next dev`;
          // allow that to take longer than a local warm boot.
          timeout: 300_000,
          env: {
            FRONTEND_PORT: localFrontendPort,
            ...(instantE2E ? { NODE_ENV: "production" } : {}),
          },
        },
      }),
  projects: [
    ...projects,
    // Uncomment for mobile browsers support
    /* {
      name: 'Mobile Chrome',
      use: { ...devices['Pixel 5'] },
    },
    {
      name: 'Mobile Safari',
      use: { ...devices['iPhone 12'] },
    }, */

    // Uncomment for branded browsers
    /* {
      name: 'Microsoft Edge',
      use: { ...devices['Desktop Edge'], channel: 'msedge' },
    },
    {
      name: 'Google Chrome',
      use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    } */
  ],
})
