import { dirname } from "node:path"
import type { CreateNodesV2 } from "@nx/devkit"
import {
  PUBLIC_SNAPSHOT_ROOT_INPUTS,
  PUBLIC_SOURCE_PROJECT_ROOTS,
  tagsForProjectRoot,
} from "./policy"

export const createNodesV2: CreateNodesV2 = [
  "**/{package.json,project.json}",
  (projectConfigurationFiles) =>
    projectConfigurationFiles.map((configurationFile) => {
      const root = dirname(configurationFile)
      const tags = tagsForProjectRoot(root)

      return [
        configurationFile,
        tags
          ? {
              projects: {
                [root]: {
                  tags: [...tags],
                  ...(root === "tools/publication-tests"
                    ? {
                        namedInputs: {
                          publicSnapshot: [
                            ...PUBLIC_SNAPSHOT_ROOT_INPUTS.map(
                              (path) => `{workspaceRoot}/${path}`,
                            ),
                            ...PUBLIC_SOURCE_PROJECT_ROOTS.map(
                              (path) => `{workspaceRoot}/${path}/**/*`,
                            ),
                          ],
                        },
                      }
                    : {}),
                },
              },
            }
          : {},
      ]
    }),
]
