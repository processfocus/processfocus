// @ts-check

import starlight from "@astrojs/starlight"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "astro/config"

// https://astro.build/config
export default defineConfig({
  integrations: [
    starlight({
      title: "Process Focus",
      disable404Route: true,
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/processfocus/processfocus",
        },
      ],
      sidebar: [
        { label: "Overview", slug: "docs" },
        {
          label: "Creating your first process",
          items: [
            {
              label: "Overview",
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
            { label: "Organisation", slug: "docs/concepts/organisation" },
            { label: "Processes", slug: "docs/concepts/processes" },
            { label: "Steps", slug: "docs/concepts/steps" },
            { label: "Authentication", slug: "docs/concepts/authentication" },
            { label: "Authorisation", slug: "docs/concepts/authorisation" },
          ],
        },
      ],
      customCss: ["./src/styles/starlight-custom.css"],
      components: {
        SiteTitle: "./src/components/DocsTitle.astro",
      },
      tableOfContents: {
        minHeadingLevel: 2,
        maxHeadingLevel: 3,
      },
      pagination: false,
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
