import { NodeFileSystem } from "@effect/platform-node"
import { ConfigProvider, Effect, FileSystem } from "effect"
import {
  LocalCedarConfig,
  LocalCedarConfigDefault,
  LocalCedarConfigHotReload,
  LocalCedarConfigStatic,
} from "../src/index.js"
import { expect, test } from "bun:test"

test.each(["default", "static", "hot-reload"])(
  "%s Cedar configuration loads PF_CEDAR_ROOT from ConfigProvider",
  async (mode) => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const root = yield* fs.makeTempDirectoryScoped()
          yield* fs.writeFileString(
            `${root}/policies.cedar`,
            "// configured policy",
          )
          yield* fs.writeFileString(
            `${root}/schema.cedarschema`,
            "// configured schema",
          )
          const layer =
            mode === "default"
              ? LocalCedarConfigDefault()
              : mode === "static"
                ? LocalCedarConfigStatic()
                : LocalCedarConfigHotReload(root, [])
          const config = yield* LocalCedarConfig.pipe(
            Effect.provide(layer),
            Effect.provide(
              ConfigProvider.layer(
                ConfigProvider.fromUnknown({ PF_CEDAR_ROOT: root }),
              ),
            ),
          )
          expect(config.policiesText).toEqual(["// configured policy"])
          expect(config.schemaText).toBe("// configured schema")
        }).pipe(Effect.provide(NodeFileSystem.layer)),
      ),
    )
  },
)
