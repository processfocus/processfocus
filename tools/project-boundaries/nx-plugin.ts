import { dirname } from "node:path"
import type { CreateNodesV2 } from "@nx/devkit"
import { tagsForProjectRoot } from "./policy"

export const createNodesV2: CreateNodesV2 = [
  "**/{package.json,project.json}",
  (projectConfigurationFiles) =>
    projectConfigurationFiles.map((configurationFile) => {
      const root = dirname(configurationFile)
      const tags = tagsForProjectRoot(root)

      return [
        configurationFile,
        tags ? { projects: { [root]: { tags: [...tags] } } } : {},
      ]
    }),
]
