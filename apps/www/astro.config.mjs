// @ts-check

import starlight from "@astrojs/starlight"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "astro/config"
import mermaid from "astro-mermaid"
import cedar from "./src/syntax/cedar.mjs"

export default defineConfig({
  redirects: {
    "/docs/concepts/frontend/": "/docs/concepts/dashboard/",
    "/docs/frontend/": "/docs/dashboard/",
    "/docs/frontend/notifications/": "/docs/dashboard/notifications/",
    "/docs/frontend/process-execution/": "/docs/dashboard/process-execution/",
    "/docs/frontend/retrying-a-process-execution/":
      "/docs/dashboard/retrying-a-process-execution/",
    "/docs/frontend/todos/": "/docs/dashboard/todos/",
    "/docs/frontend/visualisation/": "/docs/dashboard/visualisation/",
    "/docs/concepts/visualisation/": "/docs/dashboard/visualisation/",
    "/docs/concepts/system-steps/":
      "/docs/reference/process-steps/system-steps/",
    "/docs/concepts/process-execution/": "/docs/dashboard/process-execution/",
    "/docs/reference/retrying-a-process-execution/":
      "/docs/dashboard/retrying-a-process-execution/",
    "/docs/concepts/starting-processes-on-a-schedule/":
      "/docs/reference/starting-processes-on-a-schedule/",
    "/docs/reference/processes/steps/": "/docs/reference/process-steps/",
    "/docs/reference/forms/": "/docs/reference/process-steps/forms/",
    "/docs/reference/embedded-forms/":
      "/docs/reference/process-steps/embedded-forms/",
    "/docs/reference/public-page-forms/":
      "/docs/reference/process-steps/public-page-forms/",
  },
  integrations: [
    mermaid({ autoTheme: true, enableLog: false }),
    starlight({
      title: "Process Focus",
      expressiveCode: {
        shiki: { langs: [cedar] },
      },
      disable404Route: true,
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/processfocus/processfocus",
        },
      ],
      sidebar: [
        { slug: "docs" },
        {
          label: "Creating your first process",
          items: [
            {
              slug: "docs/creating-your-first-process",
            },
            {
              label: "Prerequisites",
              slug: "docs/creating-your-first-process/prerequisites",
            },
            {
              label: "Create organisation",
              slug: "docs/creating-your-first-process/create-organisation",
            },
            {
              label: "Process",
              slug: "docs/creating-your-first-process/process",
            },
            {
              label: "Import",
              slug: "docs/creating-your-first-process/import",
            },
          ],
        },
        {
          label: "Concepts",
          items: [
            { label: "Introduction", slug: "docs/concepts/introduction" },
            { label: "Organisation", slug: "docs/concepts/organisation" },
            { label: "Roles", slug: "docs/concepts/roles" },
            { label: "Processes", slug: "docs/concepts/processes" },
            { label: "Steps", slug: "docs/concepts/steps" },
            { label: "Process flow", slug: "docs/concepts/process-flow" },
            { label: "Forms", slug: "docs/concepts/forms" },
            { label: "SLAs and KPIs", slug: "docs/concepts/slas-and-kpis" },
            { label: "Process Testing", slug: "docs/concepts/process-testing" },
            { label: "Lists", slug: "docs/concepts/lists" },
            { label: "Document Store", slug: "docs/concepts/document-store" },
            { label: "Authentication", slug: "docs/concepts/authentication" },
            { label: "Authorisation", slug: "docs/concepts/authorisation" },
            { label: "Runtime", slug: "docs/concepts/runtime" },
            { label: "Dashboard", slug: "docs/concepts/dashboard" },
            { label: "MCP", slug: "docs/concepts/mcp" },
            { label: "API", slug: "docs/concepts/api" },
          ],
        },
        {
          label: "Dashboard",
          items: [
            { slug: "docs/dashboard" },
            { slug: "docs/dashboard/process-execution" },
            { slug: "docs/dashboard/retrying-a-process-execution" },
            { slug: "docs/dashboard/visualisation" },
            { slug: "docs/dashboard/todos" },
            { slug: "docs/dashboard/notifications" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "Constructs", slug: "docs/reference/constructs" },
            { label: "Effect TS", slug: "docs/reference/effect-ts" },
            { label: "Configuration", slug: "docs/reference/configuration" },
            {
              label: "Organisation",
              items: [
                {
                  label: "Overview",
                  slug: "docs/reference/organisation-structure",
                },
                {
                  label: "Structure",
                  slug: "docs/reference/organisation-structure/structure",
                },
                {
                  label: "Settings",
                  slug: "docs/reference/organisation-structure/settings",
                },
              ],
            },
            {
              label: "Authentication",
              items: [
                { slug: "docs/reference/authentication" },
                {
                  label: "Invitations",
                  slug: "docs/reference/authentication/invitations",
                },
                {
                  label: "Single-Sign-On (SSO)",
                  items: [
                    {
                      slug: "docs/reference/authentication/sso",
                    },
                    {
                      label: "Google",
                      slug: "docs/reference/authentication/sso/google",
                    },
                    {
                      label: "Active Directory",
                      slug: "docs/reference/authentication/sso/active-directory",
                    },
                  ],
                },
                {
                  label: "Passkeys",
                  slug: "docs/reference/authentication/passkeys",
                },
                {
                  label: "System identities",
                  slug: "docs/reference/authentication/system-identities",
                },
                {
                  label: "First user registration",
                  slug: "docs/reference/authentication/first-user-registration",
                },
                {
                  label: "Delegated identities",
                  slug: "docs/reference/authentication/delegated-identities",
                },
              ],
            },
            {
              label: "Authorisation",
              items: [
                { slug: "docs/reference/authorisation" },
                { label: "Roles", slug: "docs/reference/authorisation/roles" },
                {
                  label: "Cedar policies",
                  slug: "docs/reference/authorisation/cedar-policies",
                },
                {
                  label: "Assigning permissions to roles",
                  slug: "docs/reference/authorisation/role-permissions",
                },
                {
                  label: "Assigning permissions to individual users",
                  slug: "docs/reference/authorisation/individual-user-permissions",
                },
                {
                  label: "Creating administrators",
                  slug: "docs/reference/authorisation/creating-administrators",
                },
                {
                  label: "Authorising external systems",
                  slug: "docs/reference/authorisation/authorising-external-systems",
                },
                {
                  label: "Delegated permissions",
                  slug: "docs/reference/authorisation/delegated-permissions",
                },
                {
                  label: "Testing permissions",
                  slug: "docs/reference/authorisation/testing-permissions",
                },
                {
                  slug: "docs/reference/authorisation/custom-cedar-permissions",
                },
              ],
            },
            {
              label: "Processes",
              items: [
                { slug: "docs/reference/processes" },
                { slug: "docs/reference/processes/process-state" },
                { label: "Phases", slug: "docs/reference/processes/phases" },
                { label: "SLAs", slug: "docs/reference/processes/slas" },
              ],
            },
            {
              label: "Process steps",
              items: [
                { slug: "docs/reference/process-steps" },
                { slug: "docs/reference/process-steps/forms" },
                { slug: "docs/reference/process-steps/form-components" },
                {
                  slug: "docs/reference/process-steps/using-process-state-in-forms",
                },
                { slug: "docs/reference/process-steps/embedded-forms" },
                { slug: "docs/reference/process-steps/public-page-forms" },
                { slug: "docs/reference/process-steps/system-steps" },
                { slug: "docs/reference/process-steps/step-context" },
              ],
            },
            { label: "GraphQL API", slug: "docs/reference/graphql" },
            { label: "MCP", slug: "docs/reference/mcp" },
            { label: "Lists", slug: "docs/reference/lists" },
            { label: "Charts", slug: "docs/reference/charts" },
            {
              label: "Storing documents",
              slug: "docs/reference/storing-documents",
            },
            {
              label: "Starting processes on a schedule",
              slug: "docs/reference/starting-processes-on-a-schedule",
            },
            { label: "Testing", slug: "docs/reference/testing" },
            { slug: "docs/reference/notifications" },
            {
              label: "Plugins",
              items: [
                { slug: "docs/reference/plugins" },
                {
                  label: "Google Drive",
                  slug: "docs/reference/plugins/google-drive",
                },
                { label: "PostHog", slug: "docs/reference/plugins/posthog" },
                { label: "Resend", slug: "docs/reference/plugins/resend" },
                { label: "Xero", slug: "docs/reference/plugins/xero" },
              ],
            },
            { label: "pfcli", slug: "docs/reference/pfcli" },
            { label: "pforg", slug: "docs/reference/pforg" },
          ],
        },
        {
          label: "Cloud",
          items: [
            {
              label: "Console",
              items: [
                { slug: "docs/cloud/console" },
                { slug: "docs/cloud/console/projects-and-environments" },
                { slug: "docs/cloud/console/deployments" },
                { slug: "docs/cloud/console/stage-configuration" },
                { slug: "docs/cloud/console/usage-and-balance" },
              ],
            },
            {
              label: "Deploy your project",
              slug: "docs/cloud/deploy-your-project",
            },
            {
              label: "Configuration",
              slug: "docs/cloud/configuration",
            },
            {
              label: "Cedar policies",
              slug: "docs/cloud/cedar-policies",
            },
            {
              label: "Custom domains",
              slug: "docs/cloud/custom-domains",
            },
          ],
        },
      ],
      customCss: ["./src/styles/starlight-custom.css"],
      components: {
        SiteTitle: "./src/components/DocsTitle.astro",
        Sidebar: "./src/components/DocsReviewSidebar.astro",
      },
      tableOfContents: {
        minHeadingLevel: 2,
        maxHeadingLevel: 3,
      },
    }),
  ],
  vite: {
    plugins: [tailwindcss()],
    server: {
      watch: {
        ignored: [
          "**/#*#", // Emacs auto-save files
          "**/.#*", // Emacs lock files
          "**/*~", // Emacs backup files
        ],
      },
    },
  },
})
